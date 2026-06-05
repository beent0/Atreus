# engineering report: building obsidian-tasks (todoist clone)

This report details the architectural design, step-by-step implementation, and debugging cycles involved in engineering the premium, self-hosted **Todoist Clone** that runs on Linux and Android, using an **Obsidian Markdown Vault** as the database backend.

---

## 1. Architectural Overview

The application is structured around a three-tier self-hosted architecture designed for high-performance and absolute local data ownership:

```
                  +---------------------------------------+
                  |  Linux Desktop / Android Mobile PWA   |
                  |     (Outfit Font, CSS Glassmorphism)   |
                  +---------------------------------------+
                                      |
                                      | WebSockets / REST API
                                      v
                  +---------------------------------------+
                  |   FastAPI Server (Uvicorn / Python)   |
                  |   Runs on Homeserver / Local Machine  |
                  +---------------------------------------+
                     /                                 \
  Bidirectional Sync /                                   \ DB Updates
                    v                                     v
+-----------------------+                       +-------------------+
|  Obsidian Vault (.md) |                       |  SQLite database  |
|  - Inbox.md           |                       |  - Karma Streaks  |
|  - Work.md            |                       |  - Goals          |
|  - Personal.md        |                       |  - Activity Logs  |
+-----------------------+                       +-------------------+
```

---

## 2. Core Code Modules

The application consists of the following components in `/home/bento/Projects/TodoistClone/`:

### A. Python Backend (FastAPI)
1. **`backend/requirements.txt`**: Equips the system with asynchronous web interfaces (`fastapi`), high-speed socket runtimes (`uvicorn`), and active file tracking (`watchfiles`).
2. **`backend/activity_db.py` (SQLite DB Manager)**: Manages local data not suited for plain Markdown files. Computes daily goals (5 tasks), weekly goals (30 tasks), daily streaks, and tracks gamified **Productivity Karma Levels** (Beginner, Intermediate, Master, Grandmaster).
3. **`backend/vault_parser.py` (Markdown Database Engine)**: The core parser/writer that reads/writes files directly inside your Obsidian Vault. 
4. **`backend/main.py` (REST & Socket Router)**: Exposes endpoints for managing tasks, project files, and templates, while running a directory watcher in the background to push socket alerts whenever files are modified in Obsidian.

### B. Premium Web Frontend (Progressive Web App)
1. **`frontend/index.html`**: Structured using HTML5 semantic wrappers. Defines placeholders for Inbox, Timeline, Calendar, Stats and Backups.
2. **`frontend/styles.css`**: Features a premium glassmorphic dark mode layout with Outlined typography, sliding transitions, and customized checkboxes. Supports five selectable themes (Indigo, Velvet, Clover, Crimson, Obsidian Glass).
3. **`frontend/app.js`**: Drives client-side navigation. Features:
   * **Boolean Filter Query Resolver**: Parses logical arguments (`today & p1` or `@work & overdue`) to filter tasks instantly.
   * **Natural-Language Parser**: Extracts priorities, tag lists, and due dates dynamically from plain text during quick-adds (e.g. `buy milk tomorrow p1 #grocery`).
   * **Visual Column-Charts Renderer**: Dynamically charts task completion metrics and daily goals progress.

---

## 3. Engineering & Debugging Audit

Two critical integration issues were identified and resolved during compilation:

### Audit 1: Unlinked JavaScript Script Tag
* **Symptom**: When loading the page, the user interface loaded with proper visual styling, but clicking *any* button (including the "Add Task" / "Create New Project" buttons) did absolutely nothing.
* **Diagnosis**: The frontend index structure was missing the main `<script src="app.js"></script>` import block.
* **Resolution**: Appended the JS script loader right before the closing `</body>` tag, enabling DOM listener registrations.

### Audit 2: Markdown Checklist Bracket Shift (Off-by-One)
* **Symptom**: Even when the web server was online, the task dashboard rendered completely blank, showing `0 tasks parsed` in the Inbox.
* **Diagnosis**: Inside `vault_parser.py`, the checklist identifier was matching standard markdown checkbox strings `"- [ ]"` and `"- [x]"` by checking if the closing bracket `]` was located at index 3:
  ```python
  sub = line[marker_idx:marker_idx+5]
  if len(sub) >= 5 and sub[3] == ']':
  ```
  However, in plain Markdown syntax:
  ```
  -   [   ]
  |   |   |
  0 1 2 3 4
  ```
  * Index 3 is the checkmark status character (either space `' '` or checkmark `'x'`).
  * Index 4 is the closing bracket `']'`.
  
  As a result, `sub[3] == ']'` was *never* true, and the parser skipped every task in the vault.
* **Resolution**: Corrected the indexing to check `sub[4] == ']'` and fetch the checkmark status from `sub[3]`:
  ```python
  sub = line[marker_idx:marker_idx+5]
  if len(sub) >= 5 and sub[4] == ']':
      is_checkbox = True
      completed = sub[3].lower() in ['x', 'v']
  ```
  This immediately fixed the parsing cycle, recovering all 8 task items in the vault database.

---

## 4. Operational Instructions

### Running Locally
Run the shell script to launch the app:
```bash
./run.sh
```

### Accessing Across Devices
* **Linux Desktop App**: Open `http://localhost:8000/` and click the **Install** icon in the right-hand corner of your browser's address bar to add a desktop launcher.
* **Android Native PWA**: Navigate to `http://<your-homeserver-ip>:8000/` on your phone's browser, tap the options menu, and select **"Add to Home Screen"** to install it in your native app drawer with full-screen viewport support.
