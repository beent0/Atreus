import os
import random
import string
import re
from datetime import date
from typing import List, Dict, Any, Tuple
from backend.activity_db import get_setting, set_setting

def generate_block_id() -> str:
    """Generates a 6-character alphanumeric block reference ID."""
    chars = string.ascii_lowercase + string.digits
    return "".join(random.choice(chars) for _ in range(6))

def get_vault_path() -> str:
    """Gets the active Obsidian vault directory, fallback to default mock vault."""
    env_path = os.environ.get("OBSIDIAN_VAULT_PATH")
    if env_path and os.path.exists(env_path):
        return env_path
        
    path = get_setting("obsidian_vault_path")
    if not path or not os.path.exists(path):
        # Default to a mock vault in workspace
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ObsidianVault")
        if not os.path.exists(path):
            os.makedirs(path)
            # Create default files
            with open(os.path.join(path, "Inbox.md"), "w") as f:
                f.write("# Inbox\n\n## Tasks\n- [ ] Welcome to Atreus! 📅 2026-05-30 🔺 🔁 every day ^welcome\n  - This task is stored directly inside Obsidian!\n  - Double-click to edit.\n")
            with open(os.path.join(path, "Work.md"), "w") as f:
                f.write("# Work\n\n## Project Alpha\n- [ ] Finish slide deck for marketing 📅 2026-06-01 ⭐ ^slide123\n- [ ] Code review for team pull request 🔵 ^code456\n")
            with open(os.path.join(path, "Personal.md"), "w") as f:
                f.write("# Personal\n\n## Health\n- [ ] Go for a 5km run 📅 2026-05-30 🔺 ^run789\n")
        set_setting("obsidian_vault_path", path)
    return path

def ensure_block_ids_in_file(filepath: str) -> bool:
    """Reads a markdown file, adds a unique block ID to tasks without one, writes back."""
    if not os.path.exists(filepath):
        return False
        
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
        
    lines = content.splitlines()
    modified = False
    
    for i, line in enumerate(lines):
        stripped = line.strip()
        indent_level = len(line) - len(line.lstrip(" "))
        marker_idx = line.find("- [")
        
        # Check if this is a checkbox line
        if marker_idx != -1 and marker_idx == indent_level:
            sub = line[marker_idx:marker_idx+5]
            if len(sub) >= 5 and sub[4] == ']':
                # Check for block ID (at the end of the line)
                words = stripped.split()
                has_id = False
                if words:
                    last_word = words[-1]
                    if last_word.startswith("^") and len(last_word) > 1 and " " not in last_word:
                        has_id = True
                
                if not has_id:
                    block_id = generate_block_id()
                    lines[i] = f"{line} ^{block_id}"
                    modified = True
                    
    if modified:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
            
    return modified

def parse_markdown_file(filepath: str, project_name: str) -> List[Dict[str, Any]]:
    """Parses a markdown file into structured task lists."""
    ensure_block_ids_in_file(filepath)
    
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
        
    lines = content.splitlines()
    tasks = []
    
    current_section = "Default"
    task_stack = []  # stack of (indent_level, task_id)
    last_task = None
    
    for line_idx, line in enumerate(lines):
        stripped = line.strip()
        indent_level = len(line) - len(line.lstrip(" "))
        
        # Parse H2/H3 as sections
        if line.startswith("## ") or line.startswith("### "):
            current_section = stripped.lstrip("#").strip()
            last_task = None
            task_stack = []
            continue
            
        # Parse tasks
        marker_idx = line.find("- [")
        is_checkbox = False
        completed = False
        
        if marker_idx != -1 and marker_idx == indent_level:
            sub = line[marker_idx:marker_idx+5]
            if len(sub) >= 5 and sub[4] == ']':
                is_checkbox = True
                completed = sub[3].lower() in ['x', 'v'] # support standard x
                
        if is_checkbox:
            section_override = None
            # Extract content text (strip checkbox prefix)
            task_text = line[marker_idx+5:].strip()
            if task_text.startswith("]"):
                task_text = task_text[1:].strip()
                
            # 1. Parse Block ID
            block_id = None
            if "^" in task_text:
                parts = task_text.split("^")
                block_id = parts[-1].strip()
                if " " not in block_id:
                    task_text = "^".join(parts[:-1]).strip()
                else:
                    block_id = None
                    
            if not block_id:
                # Should not happen as ensure_block_ids_in_file is run first, but fallback
                block_id = f"gen-{line_idx}"
                
            # 2. Parse Completion Date (✅ YYYY-MM-DD)
            completion_date = None
            if "✅" in task_text:
                match = re.search(r"✅\s*(\d{4}-\d{2}-\d{2})", task_text)
                if match:
                    completion_date = match.group(1)
                    task_text = task_text.replace(match.group(0), "").strip()
                    
            # 3. Parse Due Date (📅 YYYY-MM-DD or [due:: YYYY-MM-DD])
            due_date = None
            if "📅" in task_text:
                match = re.search(r"📅\s*(\d{4}-\d{2}-\d{2})", task_text)
                if match:
                    due_date = match.group(1)
                    task_text = task_text.replace(match.group(0), "").strip()
            elif "[due::" in task_text:
                start = task_text.find("[due::")
                end = task_text.find("]", start)
                if end != -1:
                    due_date = task_text[start+6:end].strip()
                    task_text = task_text[:start].strip() + " " + task_text[end+1:].strip()
                    
            # 3c. Parse Section Override (like [section:: In Progress] from archive files)
            if "[section::" in task_text:
                start = task_text.find("[section::")
                end = task_text.find("]", start)
                if end != -1:
                    section_override = task_text[start+10:end].strip()
                    task_text = task_text[:start].strip() + " " + task_text[end+1:].strip()
                    
            # 3b. Parse Deadline (⏰ YYYY-MM-DD HH:MM or ⏰ HH:MM)
            deadline = None
            if "⏰" in task_text:
                match = re.search(r"⏰\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}|\d{2}:\d{2})", task_text)
                if match:
                    deadline = match.group(1)
                    task_text = task_text.replace(match.group(0), "").strip()
                    
            # 4. Parse Priority (🔺 P1, ⭐ P2, 🔵 P3, default P4)
            priority = 4
            if "🔺" in task_text:
                priority = 1
                task_text = task_text.replace("🔺", "").strip()
            elif "⭐" in task_text:
                priority = 2
                task_text = task_text.replace("⭐", "").strip()
            elif "🔵" in task_text:
                priority = 3
                task_text = task_text.replace("🔵", "").strip()
            elif "[priority::" in task_text:
                start = task_text.find("[priority::")
                end = task_text.find("]", start)
                if end != -1:
                    try:
                        priority = int(task_text[start+11:end].strip())
                    except:
                        pass
                    task_text = task_text[:start].strip() + " " + task_text[end+1:].strip()
                    
            # 5. Parse Recurring (🔁 rule or [repeat:: rule])
            recurring = None
            if "🔁" in task_text:
                match = re.search(r"🔁\s*([^🎰📅🔺⭐🔵^]+)", task_text)
                if match:
                    recurring = match.group(1).strip()
                    task_text = task_text.replace(match.group(0), "").strip()
            elif "[repeat::" in task_text:
                start = task_text.find("[repeat::")
                end = task_text.find("]", start)
                if end != -1:
                    recurring = task_text[start+9:end].strip()
                    task_text = task_text[:start].strip() + " " + task_text[end+1:].strip()
                    
            # 6. Parse Tags/Labels
            labels = []
            words = task_text.split()
            title_words = []
            for w in words:
                if w.startswith("#") and len(w) > 1 and not w[1:].isdigit():
                    labels.append(w[1:])
                else:
                    title_words.append(w)
            title = " ".join(title_words)
            
            # Resolve Subtask hierarchy
            parent_id = None
            while task_stack and task_stack[-1][0] >= indent_level:
                task_stack.pop()
                
            if task_stack:
                parent_id = task_stack[-1][1]
                
            task_obj = {
                "id": block_id,
                "title": title,
                "completed": completed,
                "priority": priority,
                "due_date": due_date,
                "deadline": deadline,
                "recurring": recurring,
                "completion_date": completion_date,
                "labels": labels,
                "project": project_name,
                "section": section_override or current_section,
                "parent_id": parent_id,
                "comments": [],
                "indent_level": indent_level
            }
            
            tasks.append(task_obj)
            task_stack.append((indent_level, block_id))
            last_task = task_obj
            
        elif last_task is not None and stripped:
            # Comment line or sub-element
            if indent_level > last_task["indent_level"]:
                comment_text = stripped
                # Strip list bullets if present
                if comment_text.startswith("- ") or comment_text.startswith("* "):
                    comment_text = comment_text[2:]
                elif comment_text.startswith("1. "):
                    comment_text = comment_text[3:]
                last_task["comments"].append(comment_text)
                
    return tasks

def get_all_tasks() -> List[Dict[str, Any]]:
    """Scans all Markdown files in the vault and aggregates tasks, excluding the Archive folder."""
    vault_path = get_vault_path()
    all_tasks = []
    
    for root, dirs, files in os.walk(vault_path):
        # Exclude Archive directory
        if "Archive" in root.split(os.sep):
            continue
            
        for f in files:
            if f.endswith(".md"):
                filepath = os.path.join(root, f)
                # Compute project name relative to vault path
                rel_path = os.path.relpath(filepath, vault_path)
                project_name = os.path.splitext(rel_path)[0]
                
                try:
                    tasks = parse_markdown_file(filepath, project_name)
                    all_tasks.extend(tasks)
                except Exception as e:
                    print(f"Error parsing {filepath}: {e}")
                    
    return all_tasks

def get_projects() -> List[Dict[str, Any]]:
    """Scans vault files to retrieve list of projects, excluding the Archive folder."""
    vault_path = get_vault_path()
    projects = []
    
    for root, dirs, files in os.walk(vault_path):
        # Exclude Archive directory
        if "Archive" in root.split(os.sep):
            continue
            
        for f in files:
            if f.endswith(".md"):
                filepath = os.path.join(root, f)
                rel_path = os.path.relpath(filepath, vault_path)
                project_name = os.path.splitext(rel_path)[0]
                
                # Check how many tasks are in this project
                try:
                    tasks = parse_markdown_file(filepath, project_name)
                    active_count = sum(1 for t in tasks if not t["completed"])
                except:
                    active_count = 0
                    
                projects.append({
                    "name": project_name,
                    "active_count": active_count
                })
                
    # Sort projects, keep Inbox at top
    projects.sort(key=lambda p: (p["name"] != "Inbox", p["name"].lower()))
    return projects

def create_project(project_name: str) -> bool:
    """Creates a new project file."""
    vault_path = get_vault_path()
    filepath = os.path.join(vault_path, f"{project_name}.md")
    
    # Handle subdirectories if needed
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    
    if os.path.exists(filepath):
        return False  # Already exists
        
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(f"# {project_name}\n\n## Tasks\n")
    return True

def delete_project(project_name: str) -> bool:
    """Deletes a project file."""
    vault_path = get_vault_path()
    filepath = os.path.join(vault_path, f"{project_name}.md")
    
    if os.path.exists(filepath):
        os.remove(filepath)
        return True
    return False

def build_markdown_line(task: Dict[str, Any]) -> str:
    """Builds a standard markdown checkbox line for a task."""
    indent = " " * task.get("indent_level", 0)
    checkbox = "- [x]" if task.get("completed") else "- [ ]"
    
    # Title & tags
    title = task.get("title", "")
    tag_suffix = ""
    if task.get("labels"):
        tag_suffix = " " + " ".join(f"#{t}" for t in task["labels"])
        
    # Date
    due = ""
    if task.get("due_date"):
        due = f" 📅 {task['due_date']}"
        
    # Priority
    prio = ""
    p_val = task.get("priority", 4)
    if p_val == 1: prio = " 🔺"
    elif p_val == 2: prio = " ⭐"
    elif p_val == 3: prio = " 🔵"
    
    # Recurrence
    rec = ""
    if task.get("recurring"):
        rec = f" 🔁 {task['recurring']}"
        
    # Deadline
    dead = ""
    if task.get("deadline"):
        dead = f" ⏰ {task['deadline']}"
        
    # Completion
    comp = ""
    if task.get("completed"):
        comp_date = task.get("completion_date") or date.today().isoformat()
        comp = f" ✅ {comp_date}"
        
    # Section override
    sec = ""
    if task.get("section") and task["section"] not in ("Default", "Tasks"):
        sec = f" [section:: {task['section']}]"
        
    return f"{indent}{checkbox} {title}{tag_suffix}{due}{dead}{prio}{rec}{comp}{sec} ^{task['id']}"

def find_task_in_lines(lines: List[str], task_id: str) -> Tuple[int, int]:
    """Finds a task's start and end index (inclusive of its subtasks/comments) in file lines."""
    task_idx = -1
    for i, line in enumerate(lines):
        if f"^{task_id}" in line:
            # Confirm it's the exact block ID
            words = line.strip().split()
            if words and words[-1] == f"^{task_id}":
                task_idx = i
                break
                
    if task_idx == -1:
        return -1, -1
        
    # Determine the indentation level of the task line
    task_line = lines[task_idx]
    task_indent = len(task_line) - len(task_line.lstrip(" "))
    
    # Find any trailing lines that are comments or subtasks
    end_idx = task_idx
    for j in range(task_idx + 1, len(lines)):
        next_line = lines[j]
        if not next_line.strip():
            # Skip empty lines, but continue if there is indented content below them
            continue
        next_indent = len(next_line) - len(next_line.lstrip(" "))
        if next_indent > task_indent:
            end_idx = j
        else:
            break
            
    return task_idx, end_idx

def save_task(task: Dict[str, Any], old_project: str = None) -> bool:
    """Saves a task back to its markdown file, supporting project and section changes."""
    vault_path = get_vault_path()
    project = task["project"]
    task_id = task["id"]
    
    # Handle project move
    if old_project and old_project != project:
        # 1. Remove from old project
        removed_task, comments_and_subtasks = remove_task_from_file(old_project, task_id)
        if not removed_task:
            return False
            
        # 2. Add to new project under correct section
        task["indent_level"] = 0 # reset indent on project move
        add_task_to_file(task, comments_and_subtasks)
        return True
        
    # Standard edit / toggle within the same file
    filepath = os.path.join(vault_path, f"{project}.md")
    if not os.path.exists(filepath):
        create_project(project)
        
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
        
    lines = content.splitlines()
    start_idx, end_idx = find_task_in_lines(lines, task_id)
    
    if start_idx == -1:
        # Task doesn't exist, append it
        add_task_to_file(task)
        return True
        
    # Check if section changed
    current_line = lines[start_idx]
    # We need to scan backwards to find the current section header of the task in the file
    current_section = "Default"
    for idx in range(start_idx, -1, -1):
        line = lines[idx]
        if line.startswith("## ") or line.startswith("### "):
            current_section = line.lstrip("#").strip()
            break
            
    target_section = task.get("section", "Default")
    
    if current_section != target_section:
        # Move section: remove lines first, then re-add
        removed_task, comments_and_subtasks = remove_task_from_file(project, task_id)
        add_task_to_file(task, comments_and_subtasks)
        return True
        
    # Rebuild the main task line
    # Preserve original indent level
    task["indent_level"] = len(current_line) - len(current_line.lstrip(" "))
    new_task_line = build_markdown_line(task)
    
    # Replace the task line
    lines[start_idx] = new_task_line
    
    # Update comments in markdown if they changed
    # We remove the old comments (which are non-checkbox lines indented below start_idx) and insert new ones
    # For simplicity, let's keep the existing comments and subtasks in place.
    # If the user changed the comments, we can rebuild the comments block
    existing_comment_lines = []
    existing_subtask_lines = []
    
    # Scan child lines
    for idx in range(start_idx + 1, end_idx + 1):
        child_line = lines[idx]
        if "- [" in child_line:
            existing_subtask_lines.append(child_line)
        else:
            existing_comment_lines.append(child_line)
            
    # Rebuild comments block
    new_comment_lines = []
    task_indent = task["indent_level"]
    comment_indent = " " * (task_indent + 2)
    for comm in task.get("comments", []):
        new_comment_lines.append(f"{comment_indent}- {comm}")
        
    # Replace lines between start_idx and end_idx
    # Format: [new_task_line] + [new_comments] + [existing_subtasks]
    replacement_lines = [new_task_line] + new_comment_lines + existing_subtask_lines
    lines[start_idx:end_idx + 1] = replacement_lines
    
    with open(filepath, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
        
    return True

def add_task_to_file(task: Dict[str, Any], extra_lines: List[str] = None):
    """Appends a task to a project file under its target section."""
    vault_path = get_vault_path()
    project = task["project"]
    section = task.get("section", "Default")
    
    filepath = os.path.join(vault_path, f"{project}.md")
    if not os.path.exists(filepath):
        create_project(project)
        
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
        
    lines = content.splitlines()
    task_line = build_markdown_line(task)
    
    # Assemble lines to insert: task line + comments if any + extra lines (like subtasks)
    insert_lines = [task_line]
    
    # Add comments if any
    comment_indent = " " * (task.get("indent_level", 0) + 2)
    for comment in task.get("comments", []):
        insert_lines.append(f"{comment_indent}- {comment}")
        
    if extra_lines:
        insert_lines.extend(extra_lines)
        
    # Find section header index
    section_idx = -1
    for i, line in enumerate(lines):
        if line.startswith("## ") or line.startswith("### "):
            header_name = line.lstrip("#").strip()
            if header_name == section or (section == "Default" and header_name == "Tasks"):
                section_idx = i
                break
            
    if section_idx != -1:
        # Found section header! Insert tasks immediately below it
        lines.insert(section_idx + 1, "")
        for offset, l in enumerate(insert_lines):
            lines.insert(section_idx + 2 + offset, l)
    else:
        # Section doesn't exist, create H2 header at the bottom
        if lines and lines[-1].strip():
            lines.append("")
        if section != "Default":
            lines.append(f"## {section}")
        else:
            lines.append("## Tasks")
        lines.append("")
        lines.extend(insert_lines)
        
    with open(filepath, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

def remove_task_from_file(project: str, task_id: str) -> Tuple[bool, List[str]]:
    """Removes a task (and its children) from a markdown file. Returns (success, list_of_child_lines)."""
    vault_path = get_vault_path()
    filepath = os.path.join(vault_path, f"{project}.md")
    
    if not os.path.exists(filepath):
        return False, []
        
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
        
    lines = content.splitlines()
    start_idx, end_idx = find_task_in_lines(lines, task_id)
    
    if start_idx == -1:
        return False, []
        
    # Extract child lines (comments and subtasks)
    child_lines = lines[start_idx+1:end_idx+1]
    
    # Remove task block
    del lines[start_idx:end_idx+1]
    
    with open(filepath, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
        
    return True, child_lines

def delete_task(project: str, task_id: str) -> bool:
    """Completely deletes a task and its comments/subtasks from a project."""
    success, _ = remove_task_from_file(project, task_id)
    return success

def get_project_sections(project_name: str) -> List[str]:
    """Reads a markdown file and returns all the sections (H2/H3 headers)."""
    vault_path = get_vault_path()
    filepath = os.path.join(vault_path, f"{project_name}.md")
    
    if not os.path.exists(filepath):
        return ["Default"]
        
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
        
    lines = content.splitlines()
    sections = []
    
    for line in lines:
        if line.startswith("## ") or line.startswith("### "):
            sec = line.lstrip("#").strip()
            if sec not in sections:
                sections.append(sec)
                
    if not sections:
        sections = ["Default"]
        
    return sections

def create_section(project_name: str, section_name: str) -> bool:
    """Creates a new section H2 heading in the project file."""
    vault_path = get_vault_path()
    filepath = os.path.join(vault_path, f"{project_name}.md")
    
    if not os.path.exists(filepath):
        create_project(project_name)
        
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
        
    lines = content.splitlines()
    
    # Check if section already exists
    for line in lines:
        if line.startswith("## ") or line.startswith("### "):
            sec = line.lstrip("#").strip()
            if sec.lower() == section_name.lower():
                return False  # Already exists
                
    if lines and lines[-1].strip():
        lines.append("")
        
    lines.append(f"## {section_name}")
    lines.append("")
    
    with open(filepath, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
        
    return True

def rename_section(project_name: str, old_name: str, new_name: str) -> bool:
    """Renames an existing section header in a project markdown file."""
    vault_path = get_vault_path()
    filepath = os.path.join(vault_path, f"{project_name}.md")
    
    if not os.path.exists(filepath):
        return False
        
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
        
    lines = content.splitlines()
    modified = False
    
    for i, line in enumerate(lines):
        if line.startswith("## ") or line.startswith("### "):
            header_level = "###" if line.startswith("### ") else "##"
            sec = line.lstrip("#").strip()
            if sec == old_name:
                lines[i] = f"{header_level} {new_name}"
                modified = True
                break
                
    if modified:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        return True
    return False

def delete_section(project_name: str, section_name: str) -> bool:
    """Deletes a section header and all its content up to the next section from the project file."""
    vault_path = get_vault_path()
    filepath = os.path.join(vault_path, f"{project_name}.md")
    
    if not os.path.exists(filepath):
        return False
        
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
        
    lines = content.splitlines()
    start_idx = -1
    end_idx = -1
    
    for i, line in enumerate(lines):
        if line.startswith("## ") or line.startswith("### "):
            sec = line.lstrip("#").strip()
            if sec == section_name:
                start_idx = i
                break
                
    if start_idx == -1:
        return False
        
    # Find next section header
    for j in range(start_idx + 1, len(lines)):
        if lines[j].startswith("## ") or lines[j].startswith("### "):
            end_idx = j
            break
            
    if end_idx == -1:
        end_idx = len(lines)
        
    del lines[start_idx:end_idx]
    
    with open(filepath, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
        
    return True

def archive_task(project: str, task_id: str) -> bool:
    """Moves a task (and its children/comments) from its project file to Archive/{ProjectName}.md."""
    vault_path = get_vault_path()
    archive_dir = os.path.join(vault_path, "Archive")
    os.makedirs(archive_dir, exist_ok=True)
    
    # 1. Get task details
    filepath = os.path.join(vault_path, f"{project}.md")
    if not os.path.exists(filepath):
        return False
        
    # Parse the file to find the task object
    tasks = parse_markdown_file(filepath, project)
    task = next((t for t in tasks if t["id"] == task_id), None)
    if not task:
        return False
        
    # Force it to be completed
    task["completed"] = True
    if not task.get("completion_date"):
        task["completion_date"] = date.today().isoformat()
        
    # 2. Remove task from the project file
    removed, comments_and_subtasks = remove_task_from_file(project, task_id)
    if not removed:
        return False
        
    # 3. Add task to the Archive/{ProjectName}.md file!
    archive_filepath = os.path.join(archive_dir, f"{project}.md")
    
    # Create the archive project file with a header if it doesn't exist
    if not os.path.exists(archive_filepath):
        with open(archive_filepath, "w", encoding="utf-8") as f:
            f.write(f"# Archive - {project}\n\n## Tasks\n")
            
    # Read the archive file
    with open(archive_filepath, "r", encoding="utf-8") as f:
        content = f.read()
        
    lines = content.splitlines()
    task_line = build_markdown_line(task)
    
    # Assemble lines to insert: task line + comments + comments/subtasks from the original file
    insert_lines = [task_line]
    
    # Add comments if any
    comment_indent = " " * (task.get("indent_level", 0) + 2)
    for comment in task.get("comments", []):
        insert_lines.append(f"{comment_indent}- {comment}")
        
    if comments_and_subtasks:
        insert_lines.extend(comments_and_subtasks)
        
    # Find the "Tasks" header or append to the bottom
    section_idx = -1
    for i, line in enumerate(lines):
        if line.startswith("## ") or line.startswith("### "):
            header_name = line.lstrip("#").strip()
            if header_name == "Tasks" or header_name == "Default":
                section_idx = i
                break
                
    if section_idx != -1:
        lines.insert(section_idx + 1, "")
        for offset, l in enumerate(insert_lines):
            lines.insert(section_idx + 2 + offset, l)
    else:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append("## Tasks")
        lines.append("")
        lines.extend(insert_lines)
        
    with open(archive_filepath, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
        
    return True

def get_archived_tasks() -> List[Dict[str, Any]]:
    """Scans all Markdown files in the Archive/ subdirectory of the vault and aggregates completed tasks."""
    vault_path = get_vault_path()
    archive_path = os.path.join(vault_path, "Archive")
    if not os.path.exists(archive_path):
        return []
        
    all_archived = []
    for root, dirs, files in os.walk(archive_path):
        for f in files:
            if f.endswith(".md"):
                filepath = os.path.join(root, f)
                rel_path = os.path.relpath(filepath, archive_path)
                project_name = os.path.splitext(rel_path)[0]
                
                try:
                    tasks = parse_markdown_file(filepath, project_name)
                    all_archived.extend(tasks)
                except Exception as e:
                    print(f"Error parsing archive file {filepath}: {e}")
                    
    # Sort by completion date descending
    all_archived.sort(key=lambda t: t.get("completion_date") or "", reverse=True)
    return all_archived

def unarchive_task(project: str, task_id: str) -> bool:
    """Moves a task (and its children/comments) from Archive/{ProjectName}.md back to {ProjectName}.md."""
    vault_path = get_vault_path()
    archive_dir = os.path.join(vault_path, "Archive")
    archive_filepath = os.path.join(archive_dir, f"{project}.md")
    
    if not os.path.exists(archive_filepath):
        return False
        
    # Parse the archive file to find the task object
    tasks = parse_markdown_file(archive_filepath, project)
    task = next((t for t in tasks if t["id"] == task_id), None)
    if not task:
        return False
        
    # Force it to be uncompleted
    task["completed"] = False
    task["completion_date"] = None
    
    # 1. Remove task from the Archive file
    removed, comments_and_subtasks = remove_task_from_file(f"Archive/{project}", task_id)
    if not removed:
        return False
        
    add_task_to_file(task, comments_and_subtasks)
    
    return True


# =====================================================================
# CouchDB Tasks Data Store Adapter
# =====================================================================

COUCHDB_URL = os.environ.get("COUCHDB_URL")
COUCHDB_DB = os.environ.get("COUCHDB_DB", "atreus")

import requests

def get_couchdb_db_url() -> str:
    return f"{COUCHDB_URL.rstrip('/')}/{COUCHDB_DB}"

def couchdb_get_vault_path() -> str:
    return "/couchdb_vault"

def couchdb_get_all_tasks() -> List[Dict[str, Any]]:
    try:
        url = f"{get_couchdb_db_url()}/_find"
        payload = {
            "selector": {
                "type": "task",
                "archived": {"$ne": True}
            },
            "limit": 10000
        }
        res = requests.post(url, json=payload)
        if res.status_code == 200:
            docs = res.json().get("docs", [])
            for doc in docs:
                doc["id"] = doc["_id"]
            return docs
    except Exception as e:
        print(f"Error fetching tasks from CouchDB: {e}")
    return []

def couchdb_get_projects() -> List[Dict[str, Any]]:
    try:
        url = f"{get_couchdb_db_url()}/_find"
        payload = {
            "selector": {"type": "project"},
            "limit": 1000
        }
        res = requests.post(url, json=payload)
        if res.status_code == 200:
            docs = res.json().get("docs", [])
            if not docs:
                defaults = ["Inbox", "Work", "Personal"]
                for p in defaults:
                    requests.put(f"{get_couchdb_db_url()}/project_{p.lower()}", json={
                        "_id": f"project_{p.lower()}",
                        "type": "project",
                        "name": p
                    })
                return [{"name": p} for p in defaults]
            return [{"name": d["name"]} for d in docs]
    except Exception as e:
        print(f"Error fetching projects from CouchDB: {e}")
    return []

def couchdb_save_task(task: Dict[str, Any]) -> bool:
    try:
        task_id = task.get("id") or task.get("_id")
        if not task_id:
            import uuid
            task_id = uuid.uuid4().hex
            
        doc_url = f"{get_couchdb_db_url()}/{task_id}"
        res = requests.get(doc_url)
        doc = {
            "_id": task_id,
            "type": "task",
            "archived": False,
            "completed": False
        }
        if res.status_code == 200:
            doc = res.json()
            
        for k, v in task.items():
            if k not in ["_rev", "id"]:
                doc[k] = v
                
        res_put = requests.put(doc_url, json=doc)
        return res_put.status_code in [201, 202]
    except Exception as e:
        print(f"Error saving task to CouchDB: {e}")
    return False

def couchdb_delete_task(project: str, task_id: str) -> bool:
    try:
        doc_url = f"{get_couchdb_db_url()}/{task_id}"
        res = requests.get(doc_url)
        if res.status_code == 200:
            doc = res.json()
            doc["_deleted"] = True
            res_del = requests.put(doc_url, json=doc)
            return res_del.status_code in [201, 202]
    except Exception as e:
        print(f"Error deleting task from CouchDB: {e}")
    return False

def couchdb_create_project(name: str) -> bool:
    try:
        project_id = f"project_{name.lower()}"
        doc_url = f"{get_couchdb_db_url()}/{project_id}"
        doc = {
            "_id": project_id,
            "type": "project",
            "name": name
        }
        res = requests.put(doc_url, json=doc)
        return res.status_code in [201, 202, 412]
    except Exception as e:
        print(f"Error creating project in CouchDB: {e}")
    return False

def couchdb_delete_project(name: str) -> bool:
    try:
        project_id = f"project_{name.lower()}"
        doc_url = f"{get_couchdb_db_url()}/{project_id}"
        res = requests.get(doc_url)
        if res.status_code == 200:
            doc = res.json()
            doc["_deleted"] = True
            requests.put(doc_url, json=doc)
            
        find_url = f"{get_couchdb_db_url()}/_find"
        res_tasks = requests.post(find_url, json={
            "selector": {
                "type": "task",
                "project": name
            },
            "limit": 10000
        })
        if res_tasks.status_code == 200:
            for t in res_tasks.json().get("docs", []):
                t["_deleted"] = True
                requests.put(f"{get_couchdb_db_url()}/{t['_id']}", json=t)
                
        res_sections = requests.post(find_url, json={
            "selector": {
                "type": "section",
                "project": name
            },
            "limit": 1000
        })
        if res_sections.status_code == 200:
            for s in res_sections.json().get("docs", []):
                s["_deleted"] = True
                requests.put(f"{get_couchdb_db_url()}/{s['_id']}", json=s)
                
        return True
    except Exception as e:
        print(f"Error deleting project from CouchDB: {e}")
    return False

def couchdb_get_project_sections(project_name: str) -> List[str]:
    try:
        url = f"{get_couchdb_db_url()}/_find"
        payload = {
            "selector": {
                "type": "section",
                "project": project_name
            },
            "limit": 1000
        }
        res = requests.post(url, json=payload)
        if res.status_code == 200:
            docs = res.json().get("docs", [])
            return [d["name"] for d in docs]
    except Exception as e:
        print(f"Error fetching sections from CouchDB: {e}")
    return []

def couchdb_create_section(project_name: str, section_name: str) -> bool:
    try:
        section_id = f"section_{project_name.lower()}_{section_name.lower()}"
        doc_url = f"{get_couchdb_db_url()}/{section_id}"
        doc = {
            "_id": section_id,
            "type": "section",
            "project": project_name,
            "name": section_name
        }
        res = requests.put(doc_url, json=doc)
        return res.status_code in [201, 202, 412]
    except Exception as e:
        print(f"Error creating section in CouchDB: {e}")
    return False

def couchdb_rename_section(project_name: str, old_name: str, new_name: str) -> bool:
    try:
        old_id = f"section_{project_name.lower()}_{old_name.lower()}"
        new_id = f"section_{project_name.lower()}_{new_name.lower()}"
        
        res_old = requests.get(f"{get_couchdb_db_url()}/{old_id}")
        if res_old.status_code == 200:
            old_doc = res_old.json()
            old_doc["_deleted"] = True
            requests.put(f"{get_couchdb_db_url()}/{old_id}", json=old_doc)
            
        requests.put(f"{get_couchdb_db_url()}/{new_id}", json={
            "_id": new_id,
            "type": "section",
            "project": project_name,
            "name": new_name
        })
        
        find_url = f"{get_couchdb_db_url()}/_find"
        res_tasks = requests.post(find_url, json={
            "selector": {
                "type": "task",
                "project": project_name,
                "section": old_name
            },
            "limit": 10000
        })
        if res_tasks.status_code == 200:
            for t in res_tasks.json().get("docs", []):
                t["section"] = new_name
                requests.put(f"{get_couchdb_db_url()}/{t['_id']}", json=t)
        return True
    except Exception as e:
        print(f"Error renaming section in CouchDB: {e}")
    return False

def couchdb_delete_section(project_name: str, section_name: str) -> bool:
    try:
        section_id = f"section_{project_name.lower()}_{section_name.lower()}"
        res_sec = requests.get(f"{get_couchdb_db_url()}/{section_id}")
        if res_sec.status_code == 200:
            doc = res_sec.json()
            doc["_deleted"] = True
            requests.put(f"{get_couchdb_db_url()}/{section_id}", json=doc)
            
        find_url = f"{get_couchdb_db_url()}/_find"
        res_tasks = requests.post(find_url, json={
            "selector": {
                "type": "task",
                "project": project_name,
                "section": section_name
            },
            "limit": 10000
        })
        if res_tasks.status_code == 200:
            for t in res_tasks.json().get("docs", []):
                t["section"] = ""
                requests.put(f"{get_couchdb_db_url()}/{t['_id']}", json=t)
        return True
    except Exception as e:
        print(f"Error deleting section from CouchDB: {e}")
    return False

def couchdb_archive_task(project: str, task_id: str) -> bool:
    try:
        doc_url = f"{get_couchdb_db_url()}/{task_id}"
        res = requests.get(doc_url)
        if res.status_code == 200:
            doc = res.json()
            doc["completed"] = True
            doc["archived"] = True
            doc["completion_date"] = date.today().isoformat()
            res_put = requests.put(doc_url, json=doc)
            return res_put.status_code in [201, 202]
    except Exception as e:
        print(f"Error archiving task in CouchDB: {e}")
    return False

def couchdb_get_archived_tasks() -> List[Dict[str, Any]]:
    try:
        url = f"{get_couchdb_db_url()}/_find"
        payload = {
            "selector": {
                "type": "task",
                "archived": True
            },
            "limit": 10000
        }
        res = requests.post(url, json=payload)
        if res.status_code == 200:
            docs = res.json().get("docs", [])
            for doc in docs:
                doc["id"] = doc["_id"]
            docs.sort(key=lambda t: t.get("completion_date") or "", reverse=True)
            return docs
    except Exception as e:
        print(f"Error fetching archived tasks from CouchDB: {e}")
    return []

def couchdb_unarchive_task(project: str, task_id: str) -> bool:
    try:
        doc_url = f"{get_couchdb_db_url()}/{task_id}"
        res = requests.get(doc_url)
        if res.status_code == 200:
            doc = res.json()
            doc["completed"] = False
            doc["archived"] = False
            doc["completion_date"] = None
            res_put = requests.put(doc_url, json=doc)
            return res_put.status_code in [201, 202]
    except Exception as e:
        print(f"Error unarchiving task in CouchDB: {e}")
    return False

if COUCHDB_URL:
    get_vault_path = couchdb_get_vault_path
    get_all_tasks = couchdb_get_all_tasks
    get_projects = couchdb_get_projects
    save_task = couchdb_save_task
    delete_task = couchdb_delete_task
    create_project = couchdb_create_project
    delete_project = couchdb_delete_project
    get_project_sections = couchdb_get_project_sections
    create_section = couchdb_create_section
    rename_section = couchdb_rename_section
    delete_section = couchdb_delete_section
    archive_task = couchdb_archive_task
    get_archived_tasks = couchdb_get_archived_tasks
    unarchive_task = couchdb_unarchive_task

