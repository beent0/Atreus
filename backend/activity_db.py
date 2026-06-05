import sqlite3
import os
from datetime import datetime, date, timedelta
import json
import requests

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "activity.db")
COUCHDB_URL = os.environ.get("COUCHDB_URL")
COUCHDB_DB = os.environ.get("COUCHDB_DB", "atreus")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Initializes the database schemas."""
    if COUCHDB_URL:
        try:
            # Create the atreus database if it doesn't exist
            db_url = f"{COUCHDB_URL.rstrip('/')}/{COUCHDB_DB}"
            res = requests.put(db_url)
            if res.status_code not in [200, 201, 412]:
                print(f"Error creating CouchDB database {COUCHDB_DB}: {res.status_code} - {res.text}")
            
            # Create index for type field
            index_url = f"{db_url}/_index"
            requests.post(index_url, json={
                "index": {"fields": ["type"]},
                "name": "type-index",
                "type": "json"
            })
            
            # Create index for timestamp field (activity log)
            requests.post(index_url, json={
                "index": {"fields": ["timestamp"]},
                "name": "timestamp-index",
                "type": "json"
            })
            
            # Initialize default settings document if not exists
            settings_url = f"{db_url}/settings"
            res = requests.get(settings_url)
            if res.status_code == 404:
                default_settings = {
                    "_id": "settings",
                    "type": "settings",
                    "obsidian_vault_path": "",
                    "ollama_url": "http://localhost:11434",
                    "ollama_model": "llama3",
                    "week_start": "monday",
                    "carry_over_overdue": "true",
                    "auto_archive_completed": "true",
                    "task_sort_order": "priority_then_due",
                    "ai_custom_instructions": ""
                }
                requests.put(settings_url, json=default_settings)
        except Exception as e:
            print(f"Failed to connect or initialize CouchDB: {e}")
        return

    with get_db() as conn:
        cursor = conn.cursor()
        
        # 1. Activity Log table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS activity_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                action TEXT NOT NULL,
                task_id TEXT,
                task_title TEXT NOT NULL,
                project TEXT NOT NULL,
                details TEXT
            )
        """)
        
        # 2. Settings table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS system_settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)
        
        # Initialize default settings if not exists
        cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('obsidian_vault_path', '')")
        cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('ollama_url', 'http://localhost:11434')")
        cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('ollama_model', 'llama3')")
        cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('week_start', 'monday')")
        cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('carry_over_overdue', 'true')")
        cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('auto_archive_completed', 'true')")
        cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('task_sort_order', 'priority_then_due')")
        cursor.execute("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('ai_custom_instructions', '')")
        
        conn.commit()

def get_setting(key: str, default: str = "") -> str:
    """Gets a system setting."""
    if COUCHDB_URL:
        try:
            url = f"{COUCHDB_URL.rstrip('/')}/{COUCHDB_DB}/settings"
            res = requests.get(url)
            if res.status_code == 200:
                doc = res.json()
                return doc.get(key, default)
        except Exception as e:
            print(f"Error getting setting {key} from CouchDB: {e}")
        return default

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM system_settings WHERE key = ?", (key,))
        row = cursor.fetchone()
        return row["value"] if row else default

def set_setting(key: str, value: str):
    """Sets a system setting."""
    if COUCHDB_URL:
        try:
            url = f"{COUCHDB_URL.rstrip('/')}/{COUCHDB_DB}/settings"
            res = requests.get(url)
            doc = {"_id": "settings", "type": "settings"}
            if res.status_code == 200:
                doc = res.json()
            doc[key] = str(value)
            res = requests.put(url, json=doc)
            if res.status_code not in [200, 201, 202]:
                print(f"Failed to set setting {key} in CouchDB: {res.status_code} - {res.text}")
        except Exception as e:
            print(f"Error setting setting {key} in CouchDB: {e}")
        return

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)", (key, str(value)))
        conn.commit()

def log_action(action: str, task_id: str, task_title: str, project: str, details: dict = None):
    """Logs an action in the database."""
    if COUCHDB_URL:
        try:
            url = f"{COUCHDB_URL.rstrip('/')}/{COUCHDB_DB}"
            doc = {
                "type": "activity",
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "action": action,
                "task_id": task_id,
                "task_title": task_title,
                "project": project,
                "details": details
            }
            res = requests.post(url, json=doc)
            if res.status_code not in [200, 201, 202]:
                print(f"Failed to log action in CouchDB: {res.status_code} - {res.text}")
        except Exception as e:
            print(f"Error logging action in CouchDB: {e}")
    else:
        details_str = json.dumps(details) if details else None
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO activity_log (action, task_id, task_title, project, details) VALUES (?, ?, ?, ?, ?)",
                (action, task_id, task_title, project, details_str)
            )
            conn.commit()

def get_activity_log(limit: int = 50):
    """Retrieves the recent activity log."""
    if COUCHDB_URL:
        try:
            url = f"{COUCHDB_URL.rstrip('/')}/{COUCHDB_DB}/_find"
            payload = {
                "selector": {"type": "activity"},
                "sort": [{"timestamp": "desc"}],
                "limit": limit
            }
            res = requests.post(url, json=payload)
            if res.status_code == 200:
                docs = res.json().get("docs", [])
                activities = []
                for d in docs:
                    activities.append({
                        "id": d.get("_id"),
                        "timestamp": d.get("timestamp"),
                        "action": d.get("action"),
                        "task_id": d.get("task_id"),
                        "task_title": d.get("task_title"),
                        "project": d.get("project"),
                        "details": d.get("details")
                    })
                return activities
        except Exception as e:
            print(f"Error fetching activity log from CouchDB: {e}")
        return []

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, timestamp, action, task_id, task_title, project, details FROM activity_log ORDER BY id DESC LIMIT ?",
            (limit,)
        )
        rows = cursor.fetchall()
        
        activities = []
        for r in rows:
            details = None
            if r["details"]:
                try:
                    details = json.loads(r["details"])
                except:
                    pass
            activities.append({
                "id": r["id"],
                "timestamp": r["timestamp"],
                "action": r["action"],
                "task_id": r["task_id"],
                "task_title": r["task_title"],
                "project": r["project"],
                "details": details
            })
        return activities

def get_productivity_stats():
    """Compiles basic stats for the analytics page (completion count)."""
    # Simple count of completed tasks
    from backend.vault_parser import get_archived_tasks
    completed_count = 0
    try:
        completed_count = len(get_archived_tasks())
    except:
        pass
    return {
        "completed_count": completed_count
    }

# Auto-initialize database on import
init_db()
