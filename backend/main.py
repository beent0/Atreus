import os
import requests
import zipfile
import asyncio
import shutil
from datetime import datetime, date, timedelta
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.vault_parser import (
    get_all_tasks, get_projects, save_task, delete_task, 
    create_project, delete_project, get_vault_path,
    get_project_sections, create_section, rename_section, delete_section,
    archive_task, get_archived_tasks, unarchive_task
)
from backend.activity_db import (
    log_action, get_activity_log, get_productivity_stats, 
    get_setting, set_setting
)

app = FastAPI(title="Atreus (Obsidian Backend) API")

# Enable CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Active WebSockets clients
active_connections = set()

# Pydantic models for request bodies
class TaskModel(BaseModel):
    id: str
    title: str
    completed: bool
    priority: int
    due_date: Optional[str] = None
    deadline: Optional[str] = None
    recurring: Optional[str] = None
    completion_date: Optional[str] = None
    labels: List[str] = []
    project: str
    section: str = "Default"
    parent_id: Optional[str] = None
    comments: List[str] = []
    indent_level: int = 0

class ProjectModel(BaseModel):
    name: str

class SectionModel(BaseModel):
    name: str

class RenameSectionModel(BaseModel):
    old_name: str
    new_name: str

class SettingsModel(BaseModel):
    obsidian_vault_path: str
    daily_goal: int
    weekly_goal: int
    theme: str
    ollama_url: Optional[str] = "http://localhost:11434"
    ollama_model: Optional[str] = "llama3"
    week_start: Optional[str] = "monday"
    carry_over_overdue: Optional[bool] = True
    auto_archive_completed: Optional[bool] = True
    task_sort_order: Optional[str] = "priority_then_due"
    ai_custom_instructions: Optional[str] = ""

class TemplateModel(BaseModel):
    project_name: str
    template_name: str

# ----------------- WebSockets & Directory Watcher -----------------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_connections.add(websocket)
    try:
        while True:
            # Keep-alive
            await websocket.receive_text()
    except WebSocketDisconnect:
        active_connections.remove(websocket)

async def watch_vault_changes():
    """Background task using watchfiles to push WebSocket reload alerts when Markdown files change."""
    from watchfiles import awatch
    print("Vault folder watcher started in background...")
    while True:
        try:
            vault_path = get_vault_path()
            if os.path.exists(vault_path):
                async for changes in awatch(vault_path):
                    # Check if any modified file is a markdown file
                    md_changed = any(path.endswith(".md") for _, path in changes)
                    if md_changed:
                        # Broadcast reload event to all active sockets
                        for conn in list(active_connections):
                            try:
                                await conn.send_json({"type": "sync_tasks"})
                            except Exception:
                                active_connections.discard(conn)
            else:
                await asyncio.sleep(3)
        except Exception as e:
            print(f"Error in directory watcher: {e}")
            await asyncio.sleep(3)

@app.on_event("startup")
async def startup_event():
    # Start the folder watcher in the background
    asyncio.create_task(watch_vault_changes())
    
    # Initialize Backups Directory
    backup_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backups")
    os.makedirs(backup_dir, exist_ok=True)
    
    # Trigger an auto-backup on launch
    create_zip_backup(auto=True)

# ----------------- Task Endpoints -----------------

@app.get("/api/tasks", response_model=List[TaskModel])
def list_tasks():
    try:
        return get_all_tasks()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/tasks")
def upsert_task(task: TaskModel):
    try:
        # Determine if it's a new task or edit
        existing_tasks = get_all_tasks()
        existing = next((t for t in existing_tasks if t["id"] == task.id), None)
        
        # Save to Markdown
        success = save_task(task.dict(), old_project=existing["project"] if existing else None)
        if not success:
            raise HTTPException(status_code=400, detail="Failed to save task in Markdown.")
            
        # Log action and adjust Karma
        if not existing:
            log_action("created", task.id, task.title, task.project, {"priority": task.priority})
        else:
            # Check if toggled completion
            if existing["completed"] != task.completed:
                action = "completed" if task.completed else "uncompleted"
                log_action(action, task.id, task.title, task.project, {"priority": task.priority})
            else:
                log_action("edited", task.id, task.title, task.project, {"priority": task.priority})
                
        return {"status": "success", "task": task}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/tasks/{task_id}/toggle")
def toggle_task(task_id: str):
    try:
        existing_tasks = get_all_tasks()
        task = next((t for t in existing_tasks if t["id"] == task_id), None)
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")
            
        task["completed"] = not task["completed"]
        task["completion_date"] = date.today().isoformat() if task["completed"] else None
        
        save_task(task)
        
        action = "completed" if task["completed"] else "uncompleted"
        log_action(action, task["id"], task["title"], task["project"], {"priority": task["priority"]})
        
        return {"status": "success", "task": task}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/tasks/{project}/{task_id}")
def delete_task_endpoint(project: str, task_id: str):
    try:
        # Get task details first for logging
        existing_tasks = get_all_tasks()
        task = next((t for t in existing_tasks if t["id"] == task_id), None)
        
        success = delete_task(project, task_id)
        if not success:
            raise HTTPException(status_code=404, detail="Task not found in Markdown")
            
        if task:
            log_action("deleted", task_id, task["title"], project)
            
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/archive")
def list_archive():
    try:
        return get_archived_tasks()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/tasks/{project}/{task_id}/archive")
def archive_task_endpoint(project: str, task_id: str):
    try:
        success = archive_task(project, task_id)
        if not success:
            raise HTTPException(status_code=404, detail="Task not found or could not be archived")
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/tasks/{project}/{task_id}/unarchive")
def unarchive_task_endpoint(project: str, task_id: str):
    try:
        success = unarchive_task(project, task_id)
        if not success:
            raise HTTPException(status_code=404, detail="Task not found in archive or could not be unarchived")
        # Log unarchived event
        log_action("unarchived", task_id, "", project)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ----------------- Project Endpoints -----------------

@app.get("/api/projects")
def list_projects():
    try:
        return get_projects()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/projects")
def add_project(project: ProjectModel):
    try:
        success = create_project(project.name)
        if not success:
            raise HTTPException(status_code=400, detail="Project already exists")
        log_action("project_created", "", project.name, project.name)
        return {"status": "success", "project": project.name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/projects/{project_name}")
def delete_project_endpoint(project_name: str):
    try:
        success = delete_project(project_name)
        if not success:
            raise HTTPException(status_code=404, detail="Project not found")
        log_action("project_deleted", "", project_name, project_name)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/projects/{project_name}/sections")
def get_sections(project_name: str):
    try:
        return get_project_sections(project_name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/projects/{project_name}/sections")
def add_section(project_name: str, section: SectionModel):
    try:
        success = create_section(project_name, section.name)
        if not success:
            raise HTTPException(status_code=400, detail="Section already exists or could not be created")
        log_action("section_created", "", section.name, project_name)
        return {"status": "success", "section": section.name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.put("/api/projects/{project_name}/sections")
def edit_section(project_name: str, payload: RenameSectionModel):
    try:
        success = rename_section(project_name, payload.old_name, payload.new_name)
        if not success:
            raise HTTPException(status_code=404, detail="Section not found or could not be renamed")
        log_action("section_renamed", "", f"{payload.old_name} -> {payload.new_name}", project_name)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/projects/{project_name}/sections/{section_name}")
def remove_section(project_name: str, section_name: str):
    try:
        success = delete_section(project_name, section_name)
        if not success:
            raise HTTPException(status_code=404, detail="Section not found")
        log_action("section_deleted", "", section_name, project_name)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ----------------- Analytics & Logs -----------------

@app.get("/api/stats")
def fetch_stats():
    try:
        return get_productivity_stats()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/activity")
def fetch_activity():
    try:
        return get_activity_log()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ----------------- Settings Endpoints -----------------

@app.get("/api/settings")
def fetch_settings():
    ollama_url = os.environ.get("OLLAMA_URL") or get_setting("ollama_url", "http://localhost:11434")
    ollama_model = os.environ.get("OLLAMA_MODEL") or get_setting("ollama_model", "llama3")
    return {
        "obsidian_vault_path": get_setting("obsidian_vault_path"),
        "daily_goal": int(get_setting("daily_goal", "5")),
        "weekly_goal": int(get_setting("weekly_goal", "30")),
        "theme": get_setting("theme", "atreus-snow"),
        "ollama_url": ollama_url,
        "ollama_model": ollama_model,
        "week_start": get_setting("week_start", "monday"),
        "carry_over_overdue": get_setting("carry_over_overdue", "true") == "true",
        "auto_archive_completed": get_setting("auto_archive_completed", "true") == "true",
        "task_sort_order": get_setting("task_sort_order", "priority_then_due"),
        "ai_custom_instructions": get_setting("ai_custom_instructions", "")
    }

@app.post("/api/settings")
def save_settings(settings: SettingsModel):
    try:
        # Validate path if provided
        path = settings.obsidian_vault_path.strip()
        if path and not os.path.exists(path):
            try:
                os.makedirs(path, exist_ok=True)
            except Exception:
                raise HTTPException(status_code=400, detail="Invalid path or permission denied")
                
        set_setting("obsidian_vault_path", path)
        set_setting("daily_goal", str(settings.daily_goal))
        set_setting("weekly_goal", str(settings.weekly_goal))
        set_setting("theme", settings.theme)
        if settings.ollama_url:
            set_setting("ollama_url", settings.ollama_url.strip())
        if settings.ollama_model:
            set_setting("ollama_model", settings.ollama_model.strip())
            
        set_setting("week_start", settings.week_start or "monday")
        set_setting("carry_over_overdue", "true" if settings.carry_over_overdue else "false")
        set_setting("auto_archive_completed", "true" if settings.auto_archive_completed else "false")
        set_setting("task_sort_order", settings.task_sort_order or "priority_then_due")
        set_setting("ai_custom_instructions", settings.ai_custom_instructions or "")
        
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ----------------- Backups Endpoints -----------------

def create_zip_backup(auto=False) -> str:
    """Helper that creates a timestamped zip archive of the active Obsidian vault."""
    vault_path = get_vault_path()
    if not os.path.exists(vault_path):
        return ""
        
    backup_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backups")
    os.makedirs(backup_dir, exist_ok=True)
    
    timestamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    prefix = "auto_" if auto else "manual_"
    zip_filename = f"{prefix}backup_{timestamp}.zip"
    zip_path = os.path.join(backup_dir, zip_filename)
    
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(vault_path):
            for file in files:
                filepath = os.path.join(root, file)
                rel_path = os.path.relpath(filepath, vault_path)
                zipf.write(filepath, rel_path)
                
    # Maintain maximum of 10 backups, delete oldest
    backups = sorted(
        [os.path.join(backup_dir, f) for f in os.listdir(backup_dir) if f.endswith(".zip")],
        key=os.path.getmtime
    )
    while len(backups) > 10:
        oldest = backups.pop(0)
        os.remove(oldest)
        
    return zip_filename

@app.get("/api/backups")
def list_backups():
    backup_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backups")
    if not os.path.exists(backup_dir):
        return []
        
    backups = []
    for f in os.listdir(backup_dir):
        if f.endswith(".zip"):
            path = os.path.join(backup_dir, f)
            stat = os.stat(path)
            backups.append({
                "filename": f,
                "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                "size_kb": round(stat.st_size / 1024, 1)
            })
            
    backups.sort(key=lambda b: b["created_at"], reverse=True)
    return backups

@app.post("/api/backups")
def trigger_backup(background_tasks: BackgroundTasks):
    try:
        filename = create_zip_backup(auto=False)
        log_action("backup_created", "", filename, "Backups")
        return {"status": "success", "filename": filename}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/backups/restore")
def restore_backup(data: Dict[str, str]):
    filename = data.get("filename")
    if not filename:
        raise HTTPException(status_code=400, detail="Filename required")
        
    backup_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backups")
    zip_path = os.path.join(backup_dir, filename)
    
    if not os.path.exists(zip_path):
        raise HTTPException(status_code=404, detail="Backup file not found")
        
    vault_path = get_vault_path()
    
    # 1. Clean current vault to avoid merging deleted files
    try:
        for item in os.listdir(vault_path):
            item_path = os.path.join(vault_path, item)
            if os.path.isdir(item_path):
                shutil.rmtree(item_path)
            else:
                os.remove(item_path)
                
        # 2. Extract ZIP
        with zipfile.ZipFile(zip_path, 'r') as zipf:
            zipf.extractall(vault_path)
            
        log_action("backup_restored", "", filename, "Backups")
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to restore: {e}")

# ----------------- Project Templates -----------------

@app.post("/api/templates/export")
def export_template(data: Dict[str, str]):
    project_name = data.get("project_name")
    if not project_name:
        raise HTTPException(status_code=400, detail="Project name required")
        
    vault_path = get_vault_path()
    src_file = os.path.join(vault_path, f"{project_name}.md")
    
    if not os.path.exists(src_file):
        raise HTTPException(status_code=404, detail="Project file not found")
        
    templates_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "templates")
    os.makedirs(templates_dir, exist_ok=True)
    
    dest_file = os.path.join(templates_dir, f"{project_name}_template.md")
    
    # Strip completion markers and IDs to make it a fresh template
    try:
        with open(src_file, "r", encoding="utf-8") as f:
            content = f.read()
            
        lines = content.splitlines()
        template_lines = []
        
        for line in lines:
            # Strip block references
            cleaned = re.sub(r"\s*\^[a-zA-Z0-9]+$", "", line)
            # Reset checks from - [x] to - [ ]
            cleaned = re.sub(r"-\s*\[[xX]\]", "- [ ]", cleaned)
            # Remove completion date strings
            cleaned = re.sub(r"✅\s*\d{4}-\d{2}-\d{2}", "", cleaned)
            
            template_lines.append(cleaned)
            
        with open(dest_file, "w", encoding="utf-8") as f:
            f.write("\n".join(template_lines) + "\n")
            
        log_action("template_exported", "", f"{project_name}_template.md", "Templates")
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/templates")
def list_templates():
    templates_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "templates")
    if not os.path.exists(templates_dir):
        return []
        
    return [f.replace("_template.md", "") for f in os.listdir(templates_dir) if f.endswith("_template.md")]

@app.post("/api/templates/import")
def import_template(data: Dict[str, str]):
    project_name = data.get("project_name")
    template_name = data.get("template_name")
    
    if not project_name or not template_name:
        raise HTTPException(status_code=400, detail="Project and Template names required")
        
    templates_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "templates")
    tmpl_file = os.path.join(templates_dir, f"{template_name}_template.md")
    
    if not os.path.exists(tmpl_file):
        raise HTTPException(status_code=404, detail="Template not found")
        
    vault_path = get_vault_path()
    dest_file = os.path.join(vault_path, f"{project_name}.md")
    
    try:
        shutil.copy(tmpl_file, dest_file)
        # Force block ID updates in the newly created project file
        from backend.vault_parser import ensure_block_ids_in_file
        ensure_block_ids_in_file(dest_file)
        
        log_action("template_imported", "", f"{template_name}_template.md", project_name)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ----------------- Ollama AI Assistant Endpoint -----------------

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: List[ChatMessage]

def call_ollama_sync(url: str, payload: dict) -> dict:
    # 1. Clean the URL (remove trailing slashes, strip whitespace)
    url = url.strip().rstrip('/')
    if not url.startswith(("http://", "https://")):
        url = f"http://{url}"
        
    chat_url = f"{url}/api/chat"
    
    try:
        response = requests.post(chat_url, json=payload, timeout=40)
    except requests.exceptions.Timeout:
        raise RuntimeError("Request timed out after 40 seconds. Make sure your Ollama server is responsive and the model is loaded.")
    except requests.exceptions.ConnectionError as ce:
        raise RuntimeError(f"Connection failed: {ce}. Please check if the Ollama server is running and accessible at this URL.")
    except requests.exceptions.RequestException as re:
        raise RuntimeError(f"Request failed: {re}")

    # Check for HTTP errors
    if response.status_code != 200:
        try:
            err_json = response.json()
            err_msg = err_json.get("error", f"HTTP {response.status_code}")
        except Exception:
            err_msg = f"HTTP {response.status_code}: {response.text}"
        raise RuntimeError(err_msg)

    # Validate response structure
    try:
        data = response.json()
    except Exception:
        raise RuntimeError("Ollama returned an invalid non-JSON response.")

    if "error" in data:
        raise RuntimeError(data["error"])
        
    if "message" not in data or "content" not in data["message"]:
        raise RuntimeError("Ollama response did not contain the expected 'message' and 'content' fields.")

    return data

async def call_ollama_async(url: str, payload: dict) -> dict:
    return await asyncio.to_thread(call_ollama_sync, url, payload)

def build_assistant_system_prompt() -> str:
    tasks = get_all_tasks()
    projects = get_projects()
    today_str = date.today().isoformat()
    tomorrow_str = (date.today() + timedelta(days=1)).isoformat()
    
    # Format tasks list
    tasks_summary = []
    for t in tasks:
        status = "Completed" if t["completed"] else "Active"
        due = f"due {t['due_date']}" if t['due_date'] else "no due date"
        prio = f"P{t['priority']}"
        recur = f", recurs {t['recurring']}" if t['recurring'] else ""
        tasks_summary.append(
            f"- [{t['id']}] {t['title']} | Project: {t['project']} | Section: {t['section']} | {status} | Priority: {prio} | {due}{recur}"
        )
    tasks_text = "\n".join(tasks_summary)
    
    projects_text = ", ".join([p["name"] for p in projects])
    
    prompt = f"""You are the Atreus AI Assistant, a local productivity advisor running alongside the user's private homeserver vault.
Your goal is to help the user manage their tasks, optimize their schedule, analyze load, and plan projects.

Current Date: {today_str}

Active Projects in Vault: {projects_text}

User's Tasks Database:
{tasks_text}

You can suggest scheduling changes, draft lists, and offer strategic scheduling advice.
Crucially, you have AGENTIC CAPABILITIES. If you want to perform any file operations inside the user's Obsidian Vault, you can append special structured action tags at the VERY END of your response. The backend will parse and execute them immediately. You can output multiple action tags.

Available Action Syntax:
1. To CREATE a task:
   [ACTION: CREATE_TASK | title: Task Title | project: ProjectName | due_date: YYYY-MM-DD | priority: 1-4 | recurring: every day/etc | section: SectionName]
2. To RESCHEDULE or EDIT a task:
   [ACTION: EDIT_TASK | id: taskID | due_date: YYYY-MM-DD | priority: 1-4 | title: Optional New Title | project: Optional Project]
3. To COMPLETE a task:
   [ACTION: COMPLETE_TASK | id: taskID]
4. To CREATE a new Project:
   [ACTION: CREATE_PROJECT | name: ProjectName]

Example: If the user says "I am overwhelmed today, move my low priority tasks to tomorrow", identify tasks with P3 or P4 due today, and output:
"I have rescheduled your low priority tasks to tomorrow to give you breathing room.
[ACTION: EDIT_TASK | id: abc123 | due_date: {tomorrow_str}]
[ACTION: EDIT_TASK | id: def456 | due_date: {tomorrow_str}]"

Be helpful, concise, and focused on maximum productivity. Your responses are rendered as markdown. Do not mention system-level IDs (like 'abc123') in the conversational text itself; refer to tasks by their titles.
"""
    custom_inst = get_setting("ai_custom_instructions", "").strip()
    if custom_inst:
        prompt += f"\n\nADDITIONAL USER INSTRUCTIONS & PERSONA CONTROLS:\n{custom_inst}\n"
    return prompt

def parse_and_execute_assistant_actions(response_text: str) -> str:
    pattern = r"\[ACTION:\s*(\w+)\s*\|\s*([^\]]+)\]"
    actions = re.findall(pattern, response_text)
    
    for action_type, params_str in actions:
        params = {}
        for pair in params_str.split("|"):
            if ":" in pair:
                k, v = pair.split(":", 1)
                params[k.strip()] = v.strip()
                
        try:
            if action_type == "CREATE_TASK":
                from backend.vault_parser import generate_block_id, add_task_to_file
                task_id = generate_block_id()
                new_task = {
                    "id": task_id,
                    "title": params.get("title", "AI Task"),
                    "completed": False,
                    "priority": int(params.get("priority", 4)),
                    "due_date": params.get("due_date") if params.get("due_date") != "None" else None,
                    "recurring": params.get("recurring"),
                    "labels": [],
                    "project": params.get("project", "Inbox"),
                    "section": params.get("section", "Default"),
                    "comments": [],
                    "indent_level": 0
                }
                add_task_to_file(new_task)
                log_action("created", task_id, new_task["title"], new_task["project"], {"priority": new_task["priority"]})
                
            elif action_type == "EDIT_TASK":
                task_id = params.get("id")
                if task_id:
                    existing_tasks = get_all_tasks()
                    task = next((t for t in existing_tasks if t["id"] == task_id), None)
                    if task:
                        old_proj = task["project"]
                        if "title" in params: task["title"] = params["title"]
                        if "due_date" in params: task["due_date"] = params["due_date"] if params["due_date"] != "None" else None
                        if "priority" in params: task["priority"] = int(params["priority"])
                        if "project" in params: task["project"] = params["project"]
                        
                        save_task(task, old_project=old_proj)
                        log_action("edited", task_id, task["title"], task["project"])
                        
            elif action_type == "COMPLETE_TASK":
                task_id = params.get("id")
                if task_id:
                    existing_tasks = get_all_tasks()
                    task = next((t for t in existing_tasks if t["id"] == task_id), None)
                    if task and not task["completed"]:
                        task["completed"] = True
                        task["completion_date"] = date.today().isoformat()
                        save_task(task)
                        log_action("completed", task_id, task["title"], task["project"], {"priority": task["priority"]})
                        
            elif action_type == "CREATE_PROJECT":
                proj_name = params.get("name")
                if proj_name:
                    create_project(proj_name)
                    log_action("project_created", "", proj_name, proj_name)
        except Exception as e:
            print(f"Error executing AI action {action_type}: {e}")
            
    clean_text = re.sub(pattern, "", response_text).strip()
    return clean_text

@app.post("/api/assistant/chat")
async def assistant_chat(request: ChatRequest):
    import json
    
    ollama_url = os.environ.get("OLLAMA_URL") or get_setting("ollama_url", "http://localhost:11434")
    ollama_model = os.environ.get("OLLAMA_MODEL") or get_setting("ollama_model", "llama3")
    
    # Compile messages including system prompt
    system_prompt = build_assistant_system_prompt()
    
    compiled_messages = [{"role": "system", "content": system_prompt}]
    for msg in request.messages:
        compiled_messages.append({"role": msg.role, "content": msg.content})
        
    payload = {
        "model": ollama_model,
        "messages": compiled_messages,
        "stream": False
    }
    
    try:
        response_data = await call_ollama_async(ollama_url, payload)
        raw_reply = response_data["message"]["content"]
        
        # Execute agentic actions
        clean_reply = parse_and_execute_assistant_actions(raw_reply)
        
        # Broadcast sync so UI updates in real-time if tasks were edited
        for conn in list(active_connections):
            try:
                await conn.send_json({"type": "sync_tasks"})
            except Exception:
                active_connections.discard(conn)
                
        return {"response": clean_reply}
    except Exception as e:
        err_str = str(e)
        if "not found" in err_str.lower() or "does not exist" in err_str.lower():
            error_msg = (
                f"Connected to Ollama server at `{ollama_url}`, but the model `{ollama_model}` was not found.\n\n"
                f"**How to fix this:**\n"
                f"1. Run `ollama pull {ollama_model}` in your terminal to download the model.\n"
                f"2. Or go to **Settings** in this app and specify a different, already-pulled model."
            )
        else:
            error_msg = (
                f"Could not communicate with your local Ollama server at `{ollama_url}` using model `{ollama_model}`.\n\n"
                f"**Quick Troubleshooting Guide:**\n"
                f"1. **Is Ollama running?** Start it with `ollama serve` (or run the Ollama app).\n"
                f"2. **Docker Network:** If this app is running in Docker, set the Ollama URL to `http://host.docker.internal:11434` in Settings.\n"
                f"3. **Bind Address:** Make sure Ollama accepts outside requests by setting the environment variable `OLLAMA_HOST=0.0.0.0` before running it on the host.\n\n"
                f"*(Error details: {err_str})*"
            )
        return {"response": error_msg}

# ----------------- Serve Web Frontend -----------------

# Mount the static frontend files
frontend_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")
if os.path.exists(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
else:
    print(f"Warning: Frontend directory '{frontend_dir}' not found. UI files will need to be written first.")
