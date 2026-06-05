// ================= APPLICATION STATE =================
const state = {
    tasks: [],
    projects: [],
    activeView: 'inbox', // 'inbox', 'today', 'upcoming', 'calendar', 'filters', 'analytics', 'settings', 'backups', or a project name
    activeProject: null,
    settings: {
        obsidian_vault_path: '',
        daily_goal: 5,
        weekly_goal: 30,
        theme: 'atreus-snow',
        ollama_url: 'http://localhost:11434',
        ollama_model: 'llama3'
    },
    stats: null,
    backups: [],
    ws: null
};

const API_BASE = '/api';

// ================= DATE HELPERS =================
function getTodayISO() {
    return new Date().toISOString().split('T')[0];
}

function getTomorrowISO() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
}

function formatDateDMY(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length === 3) {
        const y = parts[0].substring(2);
        const m = parts[1];
        const d = parts[2];
        return `${d}/${m}/${y}`;
    }
    return dateStr;
}

function formatDeadlineDMY(deadlineStr) {
    if (!deadlineStr) return '';
    if (deadlineStr.includes(' ')) {
        const [datePart, timePart] = deadlineStr.split(' ');
        return `${formatDateDMY(datePart)} ${timePart}`;
    }
    return deadlineStr;
}

function formatDateTimeDMY(d) {
    if (!d || isNaN(d.getTime())) return '';
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = String(d.getFullYear()).substring(2);
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
}

function formatDateFriendly(dateStr) {
    if (!dateStr) return '';
    const today = getTodayISO();
    const tomorrow = getTomorrowISO();
    
    if (dateStr === today) return 'Today';
    if (dateStr === tomorrow) return 'Tomorrow';
    
    return formatDateDMY(dateStr);
}

function isOverdue(dateStr) {
    if (!dateStr) return false;
    return dateStr < getTodayISO();
}

// ================= INITIALIZATION & WS CONNECTION =================
document.addEventListener('DOMContentLoaded', () => {
    initApp();
});

async function initApp() {
    setupEventListeners();
    await fetchSettings();
    applyTheme(state.settings.theme);
    await syncAllData();
    setupWebSocket();
    renderSidebar();
    switchView('inbox');
}

function setupWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    state.ws = new WebSocket(wsUrl);
    
    state.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'sync_tasks') {
            showSyncBanner();
            syncAllData().then(() => {
                hideSyncBanner();
            });
        }
    };
    
    state.ws.onclose = () => {
        // Reconnect after 3 seconds
        setTimeout(setupWebSocket, 3000);
    };
}

function showSyncBanner() {
    document.getElementById('sync-banner').style.display = 'block';
}

function hideSyncBanner() {
    document.getElementById('sync-banner').style.display = 'none';
}

// ================= API WRAPPERS =================
async function syncAllData() {
    try {
        const tasksRes = await fetch(`${API_BASE}/tasks`);
        state.tasks = await tasksRes.json();
        
        const projRes = await fetch(`${API_BASE}/projects`);
        state.projects = await projRes.json();
        
        if (state.activeProject) {
            try {
                const secRes = await fetch(`${API_BASE}/projects/${state.activeProject}/sections`);
                state.activeProjectSections = await secRes.json();
            } catch (secErr) {
                console.error("Error fetching sections:", secErr);
                state.activeProjectSections = ["Default"];
            }
        } else {
            state.activeProjectSections = [];
        }
        
        await fetchStats();
        
        renderSidebar();
        renderActiveView();
    } catch (err) {
        console.error("Error syncing data:", err);
    }
}

async function fetchSettings() {
    try {
        const res = await fetch(`${API_BASE}/settings`);
        state.settings = await res.json();
    } catch (err) {
        console.error("Error fetching settings:", err);
    }
}

async function fetchStats() {
    try {
        const res = await fetch(`${API_BASE}/stats`);
        state.stats = await res.json();
    } catch (err) {
        console.error("Error fetching stats:", err);
    }
}

async function fetchBackups() {
    try {
        const res = await fetch(`${API_BASE}/backups`);
        state.backups = await res.json();
        renderBackups();
    } catch (err) {
        console.error("Error fetching backups:", err);
    }
}

// ================= THEME MANAGER =================
function applyTheme(themeName) {
    if (!themeName || themeName === 'todoist-crimson') {
        themeName = 'atreus-snow';
    }
    document.body.className = '';
    document.body.classList.add(themeName);
    
    // Update settings form active option
    document.querySelectorAll('.theme-option').forEach(opt => {
        if (opt.dataset.theme === themeName) {
            opt.classList.add('active');
        } else {
            opt.classList.remove('active');
        }
    });
}

// ================= NATURAL LANGUAGE PARSER =================
function parseNaturalLanguageTask(text) {
    let title = text;
    let priority = 4;
    let due_date = null;
    let labels = [];
    let recurring = null;
    
    // 1. Extract Tags (#word)
    const tags = title.match(/#\w+/g);
    if (tags) {
        tags.forEach(tag => {
            labels.push(tag.substring(1));
            title = title.replace(tag, '');
        });
    }
    
    // 2. Extract Priorities (p1, p2, p3, p4)
    const prioMatch = title.match(/\b(p[1234])\b/i);
    if (prioMatch) {
        priority = parseInt(prioMatch[1][1]);
        title = title.replace(prioMatch[0], '');
    }
    
    // 3. Extract Recurring (every monday, every day, etc.)
    const recurMatch = title.match(/\bevery\s+(day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    if (recurMatch) {
        recurring = recurMatch[0].toLowerCase();
        title = title.replace(recurMatch[0], '');
    }
    
    // 4. Extract Due Dates (today, tomorrow, in X days, monday, tuesday, etc.)
    const today = new Date();
    
    const resolveWeekday = (targetDay) => {
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const targetIdx = days.indexOf(targetDay.toLowerCase());
        const currentIdx = today.getDay();
        let diff = targetIdx - currentIdx;
        if (diff <= 0) diff += 7; // Next week's occurrence
        const d = new Date();
        d.setDate(today.getDate() + diff);
        return d.toISOString().split('T')[0];
    };
    
    if (/\btoday\b/i.test(title)) {
        due_date = getTodayISO();
        title = title.replace(/\btoday\b/i, '');
    } else if (/\btomorrow\b/i.test(title)) {
        due_date = getTomorrowISO();
        title = title.replace(/\btomorrow\b/i, '');
    } else if (/\bin\s+(\d+)\s+days\b/i.test(title)) {
        const match = title.match(/\bin\s+(\d+)\s+days\b/i);
        const days = parseInt(match[1]);
        const d = new Date();
        d.setDate(today.getDate() + days);
        due_date = d.toISOString().split('T')[0];
        title = title.replace(match[0], '');
    } else {
        const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        for (const day of weekdays) {
            const regex = new RegExp(`\\b${day}\\b`, 'i');
            if (regex.test(title)) {
                due_date = resolveWeekday(day);
                title = title.replace(regex, '');
                break;
            }
        }
    }
    
    return {
        title: title.replace(/\s+/g, ' ').trim(),
        priority,
        due_date,
        recurring,
        labels
    };
}

// ================= CUSTOM FILTER QUERY ENGINE =================
function evaluateTaskQuery(task, queryStr) {
    if (!queryStr || queryStr.trim() === "") return true;
    
    const todayStr = getTodayISO();
    
    const resolveTerm = (term) => {
        term = term.trim().toLowerCase();
        
        if (term === "today") {
            return task.due_date === todayStr;
        }
        if (term === "tomorrow") {
            return task.due_date === getTomorrowISO();
        }
        if (term === "overdue") {
            return task.due_date && task.due_date < todayStr && !task.completed;
        }
        if (term.startsWith("p") && term.length === 2 && ["1","2","3","4"].includes(term[1])) {
            return task.priority === parseInt(term[1]);
        }
        if (term.startsWith("@")) {
            const label = term.substring(1);
            return task.labels && task.labels.map(l => l.toLowerCase()).includes(label);
        }
        if (term.startsWith("#")) {
            const projName = term.substring(1);
            return task.project && task.project.toLowerCase() === projName;
        }
        
        // General text search
        return (task.title && task.title.toLowerCase().includes(term)) || 
               (task.project && task.project.toLowerCase().includes(term));
    };

    // Parse Logical Operators
    if (queryStr.includes("|")) {
        return queryStr.split("|").some(sub => evaluateTaskQuery(task, sub));
    }
    if (queryStr.includes("&")) {
        return queryStr.split("&").every(sub => evaluateTaskQuery(task, sub));
    }
    
    let isNegated = false;
    let cleanQuery = queryStr.trim();
    if (cleanQuery.startsWith("!")) {
        isNegated = true;
        cleanQuery = cleanQuery.substring(1).trim();
    }
    
    const result = resolveTerm(cleanQuery);
    return isNegated ? !result : result;
}

function populateSettingsForm() {
    if (state.settings) {
        document.getElementById('setting-vault-path').value = state.settings.obsidian_vault_path || '';
        document.getElementById('setting-ollama-url').value = state.settings.ollama_url || 'http://localhost:11434';
        document.getElementById('setting-ollama-model').value = state.settings.ollama_model || 'llama3';
        document.getElementById('setting-week-start').value = state.settings.week_start || 'monday';
        document.getElementById('setting-task-sort').value = state.settings.task_sort_order || 'priority_then_due';
        document.getElementById('setting-carry-over').value = state.settings.carry_over_overdue !== undefined ? String(state.settings.carry_over_overdue) : 'true';
        document.getElementById('setting-archive-behavior').value = state.settings.auto_archive_completed !== undefined ? String(state.settings.auto_archive_completed) : 'true';
        document.getElementById('setting-ai-instructions').value = state.settings.ai_custom_instructions || '';
    }
}

// ================= VIEW NAVIGATION =================
async function switchView(viewName, project_name = null) {
    state.activeView = viewName;
    state.activeProject = project_name;
    
    const viewportEl = document.getElementById('view-viewport');
    if (viewportEl) {
        viewportEl.setAttribute('data-active-view', viewName);
    }
    
    if (project_name) {
        try {
            const secRes = await fetch(`${API_BASE}/projects/${project_name}/sections`);
            state.activeProjectSections = await secRes.json();
        } catch (secErr) {
            console.error("Error fetching sections:", secErr);
            state.activeProjectSections = ["Default"];
        }
    } else {
        state.activeProjectSections = [];
    }
    
    if (viewName === 'settings') {
        populateSettingsForm();
    }
    
    // Toggle active state in sidebar nav
    document.querySelectorAll('.sidebar-nav .nav-item, .sidebar-footer .nav-item').forEach(item => {
        if (item.dataset.view === viewName && !project_name) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
    
    // Toggle project items
    document.querySelectorAll('#sidebar-projects-list .project-item').forEach(item => {
        if (project_name && item.dataset.project === project_name) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
    
    // Toggle main viewport views
    document.querySelectorAll('.viewport .view-content').forEach(view => {
        view.classList.remove('active');
    });
    
    // Map view to content panel ID
    let targetPanelId = 'view-tasks';
    if (viewName === 'calendar') targetPanelId = 'view-calendar';
    else if (viewName === 'filters') targetPanelId = 'view-filters';
    else if (viewName === 'analytics') targetPanelId = 'view-analytics';
    else if (viewName === 'matrix') targetPanelId = 'view-matrix';
    else if (viewName === 'backups') targetPanelId = 'view-backups';
    else if (viewName === 'settings') targetPanelId = 'view-settings';
    else if (viewName === 'upcoming') targetPanelId = 'view-upcoming';
    else if (viewName === 'workload') targetPanelId = 'view-workload';
    
    document.getElementById(targetPanelId).classList.add('active');
    
    // Show/hide templates button
    const headerActions = document.getElementById('project-header-actions');
    if (project_name) {
        headerActions.style.display = 'block';
    } else {
        headerActions.style.display = 'none';
    }
    
    // Close sidebar on mobile
    document.getElementById('app-sidebar').classList.remove('active');
    
    // Scroll viewport to top
    document.getElementById('view-viewport').scrollTop = 0;
    
    renderHeader();
    renderActiveView();
}

function renderHeader() {
    const titleEl = document.getElementById('current-view-title');
    const subtitleEl = document.getElementById('current-view-subtitle');
    
    const formattedDate = formatDateDMY(getTodayISO());
    
    if (state.activeProject) {
        titleEl.textContent = state.activeProject;
        subtitleEl.textContent = "Obsidian Project Vault File";
    } else {
        switch (state.activeView) {
            case 'inbox':
                titleEl.textContent = "Inbox";
                subtitleEl.textContent = formattedDate;
                break;
            case 'today':
                titleEl.textContent = "Today";
                subtitleEl.textContent = formattedDate;
                break;
            case 'upcoming':
                titleEl.textContent = "Upcoming";
                subtitleEl.textContent = "7-Day Planner Timeline";
                break;
            case 'calendar':
                titleEl.textContent = "Calendar";
                subtitleEl.textContent = "Vault Schedule View";
                break;
            case 'filters':
                titleEl.textContent = "Filters & Tags";
                subtitleEl.textContent = "Advanced Query Desk";
                break;
            case 'analytics':
                titleEl.textContent = "Archive & Activity";
                subtitleEl.textContent = "Obsidian Completed & Archived Task Vault";
                break;
            case 'backups':
                titleEl.textContent = "Backup Manager";
                subtitleEl.textContent = "Obsidian ZIP Archive System";
                break;
            case 'settings':
                titleEl.textContent = "Preferences";
                subtitleEl.textContent = "Configure System Engine";
                break;
            case 'workload':
                titleEl.textContent = "Workload";
                subtitleEl.textContent = "Task commitment density heatmap";
                break;
            case 'matrix':
                titleEl.textContent = "Priority Matrix";
                subtitleEl.textContent = "Eisenhower Urgent-Important Decision Grid";
                break;
        }
    }
}

// ================= VIEW RENDERING ENGINES =================

function renderActiveView() {
    switch (state.activeView) {
        case 'inbox':
            renderTasksList(state.tasks.filter(t => t.project === 'Inbox' && !t.completed));
            break;
        case 'today':
            const todayStr = getTodayISO();
            renderTasksList(state.tasks.filter(t => (t.due_date === todayStr || (t.due_date && t.due_date < todayStr)) && !t.completed));
            break;
        case 'upcoming':
            renderUpcomingTimeline();
            break;
        case 'calendar':
            renderCalendar();
            break;
        case 'filters':
            renderLabelsCloud();
            break;
        case 'analytics':
            renderAnalytics();
            break;
        case 'matrix':
            renderPriorityMatrix();
            break;
        case 'backups':
            fetchBackups();
            break;
        case 'workload':
            renderWorkloadMap();
            break;
        default:
            // Render specific project
            if (state.activeProject) {
                renderTasksList(state.tasks.filter(t => t.project === state.activeProject && !t.completed));
            }
            break;
    }
}

// ----------------- SIDEBAR RENDER -----------------
function renderSidebar() {
    // 1. Update primary badge counts
    const inboxCount = state.tasks.filter(t => t.project === 'Inbox' && !t.completed).length;
    document.getElementById('badge-inbox-count').textContent = inboxCount || '';
    
    const todayStr = getTodayISO();
    const todayCount = state.tasks.filter(t => (t.due_date === todayStr || (t.due_date && t.due_date < todayStr)) && !t.completed).length;
    document.getElementById('badge-today-count').textContent = todayCount || '';
    
    // 2. Populate Projects List
    const listEl = document.getElementById('sidebar-projects-list');
    listEl.innerHTML = '';
    
    // Exclude Inbox from customizable projects list since it's hardcoded at top
    const projectsList = state.projects.filter(p => p.name !== 'Inbox');
    
    if (projectsList.length === 0) {
        listEl.innerHTML = '<li class="input-tip" style="padding: 10px 14px;">No custom projects</li>';
        return;
    }
    
    projectsList.forEach(p => {
        const li = document.createElement('li');
        li.className = `project-item ${state.activeProject === p.name ? 'active' : ''}`;
        li.dataset.project = p.name;
        
        li.innerHTML = `
            <div class="project-item-left">
                <div class="project-item-dot" style="background-color: var(--accent);"></div>
                <span>${p.name}</span>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
                <span class="badge">${p.active_count || ''}</span>
                <button class="btn-delete-project" onclick="event.stopPropagation(); triggerDeleteProject('${p.name}')">
                    <i class="fa-regular fa-trash-can"></i>
                </button>
            </div>
        `;
        
        // Register drop zone for project item
        li.addEventListener('dragover', (e) => {
            e.preventDefault();
            li.classList.add('drag-over');
        });
        li.addEventListener('dragleave', () => {
            li.classList.remove('drag-over');
        });
        li.addEventListener('drop', async (e) => {
            e.preventDefault();
            li.classList.remove('drag-over');
            
            const taskId = e.dataTransfer.getData('text/plain');
            const task = state.tasks.find(t => t.id === taskId);
            if (!task) return;
            
            task.project = p.name;
            task.section = ''; // Reset section to top-level of the new project
            
            try {
                const res = await fetch(`${API_BASE}/tasks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(task)
                });
                const result = await res.json();
                if (result.status === 'success') {
                    await syncAllData();
                }
            } catch (err) {
                console.error(`Error moving task to project ${p.name} via drag-and-drop:`, err);
            }
        });
        
        li.onclick = () => switchView('project', p.name);
        listEl.appendChild(li);
    });
}

// ----------------- TASKS LIST RENDERING -----------------
function renderTasksList(taskList) {
    const flowEl = document.getElementById('tasks-list-content');
    flowEl.innerHTML = '';
    
    if (state.activeProject) {
        flowEl.classList.add('board-layout');
    } else {
        flowEl.classList.remove('board-layout');
    }
    
    // Group tasks by section
    const sections = {};
    if (state.activeProject && state.activeProjectSections) {
        state.activeProjectSections.forEach(sec => {
            sections[sec] = [];
        });
        taskList.forEach(task => {
            const secName = task.section || 'Default';
            if (!sections[secName]) sections[secName] = [];
            sections[secName].push(task);
        });
    } else {
        // Flat list view: keep all tasks in a single default list
        sections['Default'] = taskList;
    }
    
    // If no sections or only empty Default section and not in a project, show placeholder
    const totalSectionsCount = Object.keys(sections).length;
    const totalTasksCount = taskList.length;
    
    if (totalTasksCount === 0 && !state.activeProject) {
        flowEl.innerHTML = `
            <div class="empty-placeholder">
                <i class="fa-solid fa-circle-check empty-icon" style="color:var(--accent);"></i>
                <h3>All Clear!</h3>
                <p>No active tasks found in this view.</p>
            </div>
        `;
        return;
    }
    
    // Resolve sorting
    const sortTasks = (arr) => {
        const sortOrder = (state.settings && state.settings.task_sort_order) || 'priority_then_due';
        return arr.sort((a, b) => {
            if (a.completed !== b.completed) return a.completed ? 1 : -1;
            
            if (sortOrder === 'due_then_priority') {
                if (a.due_date && b.due_date) {
                    if (a.due_date !== b.due_date) return a.due_date.localeCompare(b.due_date);
                } else if (a.due_date || b.due_date) {
                    return a.due_date ? -1 : 1;
                }
                return a.priority - b.priority;
            } else if (sortOrder === 'project_then_priority') {
                const projA = a.project || '';
                const projB = b.project || '';
                if (projA !== projB) return projA.localeCompare(projB);
                return a.priority - b.priority;
            } else {
                // priority_then_due
                if (a.priority !== b.priority) return a.priority - b.priority;
                if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
                return a.due_date ? -1 : b.due_date ? 1 : 0;
            }
        });
    };
    
    // Render each section block
    Object.keys(sections).forEach(secName => {
        const secBlock = document.createElement('div');
        secBlock.className = 'section-block';
        secBlock.dataset.section = secName;
        
        // Register drop zone for section block
        secBlock.addEventListener('dragover', (e) => {
            e.preventDefault();
            secBlock.classList.add('drag-over');
        });
        
        secBlock.addEventListener('dragleave', () => {
            secBlock.classList.remove('drag-over');
        });
        
        secBlock.addEventListener('drop', async (e) => {
            e.preventDefault();
            secBlock.classList.remove('drag-over');
            
            const taskId = e.dataTransfer.getData('text/plain');
            const task = state.tasks.find(t => t.id === taskId);
            if (!task) return;
            
            // Set the target section
            task.section = secName === 'Default' ? '' : secName;
            
            // If the task was dragged from another project and we're looking at a custom project
            if (state.activeProject) {
                task.project = state.activeProject;
            }
            
            try {
                const res = await fetch(`${API_BASE}/tasks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(task)
                });
                const result = await res.json();
                if (result.status === 'success') {
                    await syncAllData();
                }
            } catch (err) {
                console.error("Error updating section on drop:", err);
            }
        });
        
        if (state.activeProject) {
            const titleEl = document.createElement('div');
            titleEl.className = 'section-block-title';
            
            const titleText = document.createElement('span');
            titleText.textContent = secName === 'Default' ? 'Tasks' : secName;
            titleEl.appendChild(titleText);
            
            const actionsEl = document.createElement('div');
            actionsEl.className = 'section-actions';
            
            // Add Task Button
            const btnAddTask = document.createElement('button');
            btnAddTask.className = 'btn-section-action';
            btnAddTask.title = "Add Task to this Section";
            btnAddTask.innerHTML = '<i class="fa-solid fa-plus"></i>';
            btnAddTask.onclick = (e) => {
                e.stopPropagation();
                openAddTaskModalForSection(state.activeProject, secName);
            };
            actionsEl.appendChild(btnAddTask);
            
            if (secName !== 'Default' && secName !== 'Tasks') {
                // Rename Button
                const btnRename = document.createElement('button');
                btnRename.className = 'btn-section-action';
                btnRename.title = "Rename Section";
                btnRename.innerHTML = '<i class="fa-regular fa-edit"></i>';
                btnRename.onclick = (e) => {
                    e.stopPropagation();
                    triggerRenameSection(state.activeProject, secName);
                };
                actionsEl.appendChild(btnRename);
                
                // Delete Button
                const btnDelete = document.createElement('button');
                btnDelete.className = 'btn-section-action btn-section-delete';
                btnDelete.title = "Delete Section and Tasks";
                btnDelete.innerHTML = '<i class="fa-regular fa-trash-can"></i>';
                btnDelete.onclick = (e) => {
                    e.stopPropagation();
                    triggerDeleteSection(state.activeProject, secName);
                };
                actionsEl.appendChild(btnDelete);
            }
            titleEl.appendChild(actionsEl);
            secBlock.appendChild(titleEl);
        }
        
        const flow = document.createElement('div');
        flow.className = 'tasks-flow';
        
        const sorted = sortTasks(sections[secName]);
        
        if (sorted.length === 0) {
            const emptySec = document.createElement('div');
            emptySec.className = 'empty-section-tip';
            emptySec.innerHTML = `<span style="color:var(--text-muted); font-size:13px; font-style:italic;">No tasks in this section.</span>`;
            flow.appendChild(emptySec);
        } else {
            sorted.forEach(task => {
                const item = document.createElement('div');
                const prioColor = task.priority === 1 ? 'var(--prio-1)' : 
                                 task.priority === 2 ? 'var(--prio-2)' : 
                                 task.priority === 3 ? 'var(--prio-3)' : 'var(--prio-4)';
                                 
                item.className = `task-item indent-${task.indent_level || 0} ${task.completed ? 'completed' : ''} ${task.deadline ? 'deadline-task' : ''}`;
                item.dataset.taskId = task.id;
                item.style.setProperty('--prio-color', prioColor);
                
                // Enable dragging
                item.draggable = true;
                item.addEventListener('dragstart', (e) => {
                    e.dataTransfer.setData('text/plain', task.id);
                    e.dataTransfer.setData('source-project', task.project);
                    e.dataTransfer.setData('source-view', 'list');
                    item.classList.add('dragging');
                });
                item.addEventListener('dragend', () => {
                    item.classList.remove('dragging');
                });
                
                // Build task tags list
                let tagsHtml = '';
                
                // Due date tag
                if (task.due_date) {
                    const isLate = isOverdue(task.due_date) && !task.completed;
                    tagsHtml += `
                        <span class="task-tag date-tag ${isLate ? 'overdue' : ''}">
                            <i class="fa-regular fa-calendar"></i> ${formatDateFriendly(task.due_date)}
                        </span>
                    `;
                }
                
                // Deadline tag
                if (task.deadline) {
                    let isLate = false;
                    let displayStr = task.deadline;
                    
                    try {
                        let deadlineDate;
                        if (task.deadline.includes('-')) {
                            deadlineDate = new Date(task.deadline.replace(' ', 'T'));
                        } else {
                            deadlineDate = new Date();
                            const [hh, mm] = task.deadline.split(':');
                            deadlineDate.setHours(parseInt(hh), parseInt(mm), 0, 0);
                        }
                        
                        if (deadlineDate < new Date() && !task.completed) {
                            isLate = true;
                        }
                        
                        const diffMs = deadlineDate - new Date();
                        if (diffMs > 0 && diffMs < 86400000 && !task.completed) {
                            const diffMins = Math.round(diffMs / 60000);
                            const hours = Math.floor(diffMins / 60);
                            const mins = diffMins % 60;
                            displayStr = `Deadline: ${hours > 0 ? hours + 'h ' : ''}${mins}m left`;
                        } else {
                            displayStr = `Deadline: ${formatDeadlineDMY(task.deadline)}`;
                        }
                    } catch (e) {
                        console.error(e);
                    }
                    
                    tagsHtml += `
                        <span class="task-tag date-tag ${isLate ? 'overdue' : ''}" style="${isLate ? '' : 'background-color:rgba(255, 74, 74, 0.08); color:#FF6B6B; border: 1px solid rgba(255, 74, 74, 0.2);'}">
                            <i class="fa-solid fa-hourglass-half"></i> ${displayStr}
                        </span>
                    `;
                }
                
                // Recur tag
                if (task.recurring) {
                    tagsHtml += `
                        <span class="task-tag recur-tag">
                            <i class="fa-solid fa-arrows-rotate"></i> ${task.recurring}
                        </span>
                    `;
                }
                
                // Label tags
                if (task.labels && task.labels.length > 0) {
                    task.labels.forEach(l => {
                        tagsHtml += `
                            <span class="task-tag">
                                <i class="fa-solid fa-tag"></i> ${l}
                            </span>
                        `;
                    });
                }
                
                // Project tag (only show if not inside project view)
                if (!state.activeProject) {
                    tagsHtml += `
                        <span class="task-tag project-tag">
                            <i class="fa-solid fa-folder-open"></i> ${task.project}
                        </span>
                    `;
                    
                    if (task.section && task.section !== 'Default' && task.section !== 'Tasks') {
                        tagsHtml += `
                            <span class="task-tag section-tag" style="background-color:rgba(154, 75, 255, 0.08); color:var(--accent); border:1px solid rgba(154, 75, 255, 0.2);">
                                <i class="fa-solid fa-bars-staggered"></i> ${task.section}
                            </span>
                        `;
                    }
                }
                
                // Build comments list if any
                let commentsHtml = '';
                if (task.comments && task.comments.length > 0) {
                    commentsHtml = `
                        <div class="task-comments-list">
                            ${task.comments.map(c => `<div class="task-comment-item">• ${c}</div>`).join('')}
                        </div>
                    `;
                }
                
                item.innerHTML = `
                    <div class="task-checkbox-container">
                        <button class="task-checkbox" onclick="event.stopPropagation(); toggleTaskComplete('${task.id}')">
                            <i class="fa-solid fa-check"></i>
                        </button>
                    </div>
                    <div class="task-details" onclick="openEditTaskModal('${task.id}')">
                        <div class="task-title">${task.title}</div>
                        <div class="task-meta">
                            ${tagsHtml}
                        </div>
                        ${commentsHtml}
                    </div>
                    <div class="task-actions">
                        <button class="btn-icon" onclick="event.stopPropagation(); openEditTaskModal('${task.id}')" title="Edit Task">
                            <i class="fa-regular fa-pen-to-square"></i>
                        </button>
                        <button class="btn-icon" onclick="event.stopPropagation(); triggerDeleteTask('${task.project}', '${task.id}')" title="Delete Task">
                            <i class="fa-regular fa-trash-can"></i>
                        </button>
                    </div>
                `;
                
                flow.appendChild(item);
            });
        }
        
        secBlock.appendChild(flow);
        flowEl.appendChild(secBlock);
    });
    
    // Add Section button at the bottom of the project view
    if (state.activeProject) {
        const addSecContainer = document.createElement('div');
        addSecContainer.className = 'add-section-container';
        
        const btnAddSec = document.createElement('button');
        btnAddSec.className = 'btn btn-secondary-sm';
        btnAddSec.style.marginTop = '16px';
        btnAddSec.style.width = '100%';
        btnAddSec.style.justifyContent = 'center';
        btnAddSec.style.gap = '8px';
        btnAddSec.innerHTML = '<i class="fa-solid fa-plus"></i> Add Section';
        btnAddSec.onclick = () => {
            triggerAddSection(state.activeProject);
        };
        addSecContainer.appendChild(btnAddSec);
        flowEl.appendChild(addSecContainer);
    }
}

// ----------------- SECTION MANAGEMENT ACTIONS -----------------
function openAddTaskModalForSection(projectName, sectionName) {
    openAddTaskModal();
    // Prefill the project and section inputs!
    document.getElementById('task-input-project').value = projectName;
    document.getElementById('task-input-section').value = sectionName;
}

async function triggerAddSection(projectName) {
    const name = prompt("Enter new section name:");
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    
    try {
        const res = await fetch(`${API_BASE}/projects/${projectName}/sections`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: trimmed })
        });
        const result = await res.json();
        if (result.status === 'success') {
            await syncAllData();
        } else {
            alert(result.detail || "Could not add section");
        }
    } catch (err) {
        console.error(err);
        alert("Error adding section");
    }
}

async function triggerRenameSection(projectName, oldName) {
    const newName = prompt(`Rename section "${oldName}" to:`, oldName);
    if (!newName) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    
    try {
        const res = await fetch(`${API_BASE}/projects/${projectName}/sections`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ old_name: oldName, new_name: trimmed })
        });
        const result = await res.json();
        if (result.status === 'success') {
            await syncAllData();
        } else {
            alert(result.detail || "Could not rename section");
        }
    } catch (err) {
        console.error(err);
        alert("Error renaming section");
    }
}

async function triggerDeleteSection(projectName, sectionName) {
    if (!confirm(`Are you sure you want to delete the section "${sectionName}" and all of its tasks? This action cannot be undone.`)) {
        return;
    }
    
    try {
        const res = await fetch(`${API_BASE}/projects/${projectName}/sections/${sectionName}`, {
            method: 'DELETE'
        });
        const result = await res.json();
        if (result.status === 'success') {
            await syncAllData();
        } else {
            alert(result.detail || "Could not delete section");
        }
    } catch (err) {
        console.error(err);
        alert("Error deleting section");
    }
}

// ----------------- UPCOMING RENDERING -----------------
function renderUpcomingTimeline() {
    const listEl = document.getElementById('upcoming-timeline-content');
    listEl.innerHTML = '';
    
    // Group active tasks by next 7 days
    const today = new Date();
    const days = [];
    
    for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(today.getDate() + i);
        const iso = d.toISOString().split('T')[0];
        
        const tasks = state.tasks.filter(t => t.due_date === iso && !t.completed);
        
        days.push({
            dateStr: iso,
            label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'long' }),
            dateFormatted: formatDateDMY(iso),
            tasks
        });
    }
    
    // Check if there are overdue tasks
    const overdueTasks = state.tasks.filter(t => t.due_date && t.due_date < getTodayISO() && !t.completed);
    
    if (overdueTasks.length > 0) {
        // Prepend Overdue block
        const overdueBlock = document.createElement('div');
        overdueBlock.className = 'timeline-day-block';
        
        overdueBlock.innerHTML = `
            <div class="timeline-day-header" style="border-color: var(--prio-1);">
                <span style="color:var(--prio-1); font-weight:800;">Overdue Tasks</span>
                <span>Attention required</span>
            </div>
            <div class="tasks-flow" id="overdue-flow-content"></div>
        `;
        listEl.appendChild(overdueBlock);
        
        // Render overdue tasks in it
        const originalActive = state.activeProject;
        state.activeProject = null; // force project tag labels
        renderTasksListIntoFlow(overdueTasks, overdueBlock.querySelector('.tasks-flow'));
        state.activeProject = originalActive;
    }
    
    // Render 7 days blocks
    days.forEach(day => {
        const block = document.createElement('div');
        block.className = 'timeline-day-block';
        block.dataset.date = day.dateStr;
        
        block.innerHTML = `
            <div class="timeline-day-header">
                <span>${day.label}</span>
                <span>${day.dateFormatted}</span>
            </div>
            <div class="tasks-flow"></div>
        `;
        
        // Register drop zone for each timeline day block
        block.addEventListener('dragover', (e) => {
            e.preventDefault();
            block.classList.add('drag-over');
        });
        
        block.addEventListener('dragleave', () => {
            block.classList.remove('drag-over');
        });
        
        block.addEventListener('drop', async (e) => {
            e.preventDefault();
            block.classList.remove('drag-over');
            
            const taskId = e.dataTransfer.getData('text/plain');
            const task = state.tasks.find(t => t.id === taskId);
            if (!task) return;
            
            task.due_date = day.dateStr;
            
            try {
                const res = await fetch(`${API_BASE}/tasks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(task)
                });
                const result = await res.json();
                if (result.status === 'success') {
                    await syncAllData();
                }
            } catch (err) {
                console.error("Error updating due date on drop in timeline:", err);
            }
        });
        
        listEl.appendChild(block);
        
        if (day.tasks.length === 0) {
            block.querySelector('.tasks-flow').innerHTML = '<div class="input-tip" style="padding: 10px 0;">No scheduled tasks</div>';
        } else {
            const originalActive = state.activeProject;
            state.activeProject = null;
            renderTasksListIntoFlow(day.tasks, block.querySelector('.tasks-flow'));
            state.activeProject = originalActive;
        }
    });
}

function renderTasksListIntoFlow(taskList, flowEl) {
    taskList.forEach(task => {
        const item = document.createElement('div');
        const prioColor = task.priority === 1 ? 'var(--prio-1)' : 
                         task.priority === 2 ? 'var(--prio-2)' : 
                         task.priority === 3 ? 'var(--prio-3)' : 'var(--prio-4)';
                         
        item.className = `task-item ${task.completed ? 'completed' : ''} ${task.deadline ? 'deadline-task' : ''}`;
        item.dataset.taskId = task.id;
        item.style.setProperty('--prio-color', prioColor);
        
        // Enable dragging in timeline flow
        item.draggable = true;
        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', task.id);
            e.dataTransfer.setData('source-project', task.project);
            e.dataTransfer.setData('source-view', 'upcoming');
            item.classList.add('dragging');
        });
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
        });
        
        item.innerHTML = `
            <div class="task-checkbox-container">
                <button class="task-checkbox" onclick="event.stopPropagation(); toggleTaskComplete('${task.id}')">
                    <i class="fa-solid fa-check"></i>
                </button>
            </div>
            <div class="task-details" onclick="openEditTaskModal('${task.id}')">
                <div class="task-title">${task.title}</div>
                <div class="task-meta">
                    <span class="task-tag project-tag"><i class="fa-solid fa-folder-open"></i> ${task.project}</span>
                    ${task.recurring ? `<span class="task-tag recur-tag"><i class="fa-solid fa-arrows-rotate"></i> ${task.recurring}</span>` : ''}
                </div>
            </div>
        `;
        flowEl.appendChild(item);
    });
}

// ----------------- CALENDAR RENDERING -----------------
let calendarCurrentDate = new Date();

function renderCalendar() {
    const gridEl = document.getElementById('calendar-grid-days');
    gridEl.innerHTML = '';
    
    const year = calendarCurrentDate.getFullYear();
    const month = calendarCurrentDate.getMonth();
    
    document.getElementById('cal-month-year').textContent = calendarCurrentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    
    // Update weekday headers based on start week setting
    const headerEl = document.querySelector('.calendar-grid-header');
    const isMondayStart = (state.settings && state.settings.week_start) === 'monday';
    if (headerEl) {
        if (isMondayStart) {
            headerEl.innerHTML = '<div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div><div>Sun</div>';
        } else {
            headerEl.innerHTML = '<div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div>';
        }
    }
    
    // First day of month
    const firstDay = new Date(year, month, 1).getDay();
    // Total days in month
    const totalDays = new Date(year, month + 1, 0).getDate();
    
    // Fill empty cells before first day
    const emptyCells = isMondayStart ? (firstDay + 6) % 7 : firstDay;
    for (let i = 0; i < emptyCells; i++) {
        const cell = document.createElement('div');
        cell.className = 'calendar-day empty';
        gridEl.appendChild(cell);
    }
    
    // Fill day cells
    for (let day = 1; day <= totalDays; day++) {
        const cell = document.createElement('div');
        cell.className = 'calendar-day';
        
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        
        if (dateStr === getTodayISO()) {
            cell.classList.add('today');
        }
        
        cell.innerHTML = `
            <div class="day-number">${day}</div>
            <div class="day-tasks"></div>
        `;
        
        // Find tasks due on this date
        const dayTasks = state.tasks.filter(t => t.due_date === dateStr);
        const tasksBox = cell.querySelector('.day-tasks');
        
        dayTasks.forEach(task => {
            const prioColor = task.priority === 1 ? 'var(--prio-1)' : 
                             task.priority === 2 ? 'var(--prio-2)' : 
                             task.priority === 3 ? 'var(--prio-3)' : 'var(--prio-4)';
            
            const dot = document.createElement('div');
            dot.className = `cal-task-dot ${task.completed ? 'completed' : ''}`;
            dot.style.setProperty('--prio-color', prioColor);
            dot.textContent = task.title;
            
            // Enable calendar task dragging
            dot.draggable = true;
            dot.addEventListener('dragstart', (e) => {
                e.stopPropagation(); // prevent clicking/dragging parent cell
                e.dataTransfer.setData('text/plain', task.id);
                e.dataTransfer.setData('source-project', task.project);
                e.dataTransfer.setData('source-view', 'calendar');
                dot.classList.add('dragging');
            });
            dot.addEventListener('dragend', () => {
                dot.classList.remove('dragging');
            });
            
            dot.onclick = (e) => {
                e.stopPropagation();
                openEditTaskModal(task.id);
            };
            
            tasksBox.appendChild(dot);
        });
        
        // Register drop zone for calendar day cell
        cell.addEventListener('dragover', (e) => {
            e.preventDefault();
            cell.classList.add('drag-over');
        });
        
        cell.addEventListener('dragleave', () => {
            cell.classList.remove('drag-over');
        });
        
        cell.addEventListener('drop', async (e) => {
            e.preventDefault();
            cell.classList.remove('drag-over');
            
            const taskId = e.dataTransfer.getData('text/plain');
            const task = state.tasks.find(t => t.id === taskId);
            if (!task) return;
            
            task.due_date = dateStr;
            
            try {
                const res = await fetch(`${API_BASE}/tasks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(task)
                });
                const result = await res.json();
                if (result.status === 'success') {
                    await syncAllData();
                }
            } catch (err) {
                console.error("Error updating due date on drop in calendar:", err);
            }
        });
        
        // Click day to quick-add task for that day
        cell.onclick = () => {
            openAddTaskModal(dateStr);
        };
        
        gridEl.appendChild(cell);
    }
}

// ----------------- FILTERS & TAGS -----------------
function renderLabelsCloud() {
    const cloudEl = document.getElementById('labels-cloud-content');
    cloudEl.innerHTML = '';
    
    // Aggregate tags
    const tags = {};
    state.tasks.forEach(t => {
        if (t.labels) {
            t.labels.forEach(l => {
                tags[l] = (tags[l] || 0) + 1;
            });
        }
    });
    
    const sortedTags = Object.keys(tags).sort();
    
    if (sortedTags.length === 0) {
        cloudEl.innerHTML = '<div class="input-tip">No tags indexed in your Markdown files. Add #hashtags to task contents.</div>';
        return;
    }
    
    sortedTags.forEach(t => {
        const btn = document.createElement('span');
        btn.className = 'cloud-tag';
        btn.innerHTML = `<i class="fa-solid fa-hashtag"></i> ${t} <span class="badge" style="background:rgba(0,0,0,0.2); border:none; margin-left:6px;">${tags[t]}</span>`;
        btn.onclick = () => {
            // Apply tag filter in text box
            document.getElementById('filter-query-input').value = `@${t}`;
            runFilterQuery();
        };
        cloudEl.appendChild(btn);
    });
}

function runFilterQuery() {
    const query = document.getElementById('filter-query-input').value.trim();
    if (!query) return;
    
    const filtered = state.tasks.filter(t => evaluateTaskQuery(t, query));
    
    // Repurpose tasks view to display queried items
    state.activeView = 'filters';
    state.activeProject = null;
    
    // Render title
    document.getElementById('current-view-title').textContent = `Query Results`;
    document.getElementById('current-view-subtitle').textContent = `Query: "${query}" (Found ${filtered.length} matches)`;
    
    // Select correct viewport view
    document.querySelectorAll('.viewport .view-content').forEach(view => {
        view.classList.remove('active');
    });
    document.getElementById('view-tasks').classList.add('active');
    
    renderTasksList(filtered);
}

// ----------------- HISTORY AND ARCHIVE RENDERER -----------------
async function renderAnalytics() {
    let archivedTasks = [];
    try {
        const res = await fetch(`${API_BASE}/archive`);
        archivedTasks = await res.json();
    } catch (err) {
        console.error("Error loading archived tasks:", err);
    }
    
    // Set stat counters
    document.getElementById('archive-total-count').textContent = archivedTasks.length;
    
    // Populate project filter dropdown
    const filterSelect = document.getElementById('archive-project-filter');
    const prevFilter = filterSelect ? filterSelect.value : 'all';
    if (filterSelect) {
        filterSelect.innerHTML = '<option value="all">All Projects</option>';
        
        const uniqueProjects = [...new Set(archivedTasks.map(t => t.project).filter(Boolean))];
        uniqueProjects.forEach(proj => {
            const opt = document.createElement('option');
            opt.value = proj;
            opt.textContent = proj;
            if (proj === prevFilter) opt.selected = true;
            filterSelect.appendChild(opt);
        });
    }
    
    // Filter and render task list
    const renderFilteredArchive = () => {
        const searchInput = document.getElementById('archive-search-input');
        const searchText = searchInput ? searchInput.value.trim().toLowerCase() : '';
        const projFilter = filterSelect ? filterSelect.value : 'all';
        const listEl = document.getElementById('archive-tasks-content');
        if (!listEl) return;
        listEl.innerHTML = '';
        
        let filtered = archivedTasks;
        if (projFilter !== 'all') {
            filtered = filtered.filter(t => t.project === projFilter);
        }
        if (searchText) {
            filtered = filtered.filter(t => 
                t.title.toLowerCase().includes(searchText) || 
                (t.labels && t.labels.some(l => l.toLowerCase().includes(searchText)))
            );
        }
        
        if (filtered.length === 0) {
            listEl.innerHTML = `
                <div style="text-align:center; padding:30px; color:var(--text-muted); font-style:italic;">
                    <i class="fa-solid fa-folder-open" style="font-size:28px; margin-bottom:8px; display:block; opacity:0.5;"></i>
                    No archived tasks found.
                </div>
            `;
            return;
        }
        
        filtered.forEach(task => {
            const item = document.createElement('div');
            item.className = 'task-item completed';
            item.style.opacity = '0.75';
            
            // Build task tags list
            let tagsHtml = '';
            if (task.labels && task.labels.length > 0) {
                task.labels.forEach(l => {
                    tagsHtml += `
                        <span class="task-tag">
                            <i class="fa-solid fa-tag"></i> ${l}
                        </span>
                    `;
                });
            }
            // Project tag
            tagsHtml += `
                <span class="task-tag project-tag">
                    <i class="fa-solid fa-folder-open"></i> ${task.project}
                </span>
            `;
            // Section tag if exists
            if (task.section && task.section !== 'Default' && task.section !== 'Tasks') {
                tagsHtml += `
                    <span class="task-tag" style="background-color:rgba(255,255,255,0.03); border:1px solid var(--border-color);">
                        <i class="fa-solid fa-circle-nodes"></i> ${task.section}
                    </span>
                `;
            }
            
            // Completion Date Tag
            if (task.completion_date) {
                tagsHtml += `
                    <span class="task-tag date-tag" style="color:var(--accent);">
                        <i class="fa-regular fa-calendar-check"></i> Archived: ${formatDateFriendly(task.completion_date)}
                    </span>
                `;
            }
            
            // Build comments list if any
            let commentsHtml = '';
            if (task.comments && task.comments.length > 0) {
                commentsHtml = `
                    <div class="task-comments-list">
                        ${task.comments.map(c => `<div class="task-comment-item">• ${c}</div>`).join('')}
                    </div>
                `;
            }
            
            item.innerHTML = `
                <div class="task-checkbox-container">
                    <button class="task-checkbox" style="background-color:var(--accent); border-color:var(--accent); cursor:default;">
                        <i class="fa-solid fa-check" style="opacity:1; transform:scale(1);"></i>
                    </button>
                </div>
                <div class="task-details" style="cursor:default; flex-grow:1;">
                    <div class="task-title" style="text-decoration:line-through; color:var(--text-muted); font-weight:500;">${task.title}</div>
                    <div class="task-meta" style="margin-top:6px; display:flex; flex-wrap:wrap; gap:6px;">
                        ${tagsHtml}
                    </div>
                    ${commentsHtml}
                </div>
                <div class="task-actions" style="margin-left:12px; display:flex; gap:8px;">
                    <button class="btn-icon" onclick="event.stopPropagation(); triggerUnarchiveTask('${task.project}', '${task.id}')" title="Unarchive Task">
                        <i class="fa-solid fa-rotate-left"></i>
                    </button>
                </div>
            `;
            
            listEl.appendChild(item);
        });
    };
    
    // Attach change/input listeners
    const searchInput = document.getElementById('archive-search-input');
    if (searchInput) searchInput.oninput = renderFilteredArchive;
    if (filterSelect) filterSelect.onchange = renderFilteredArchive;
    
    // Initial Render
    renderFilteredArchive();
    
    // 5. Fetch Activity Logs
    fetchActivityLogs();
}

async function fetchActivityLogs() {
    try {
        const res = await fetch(`${API_BASE}/activity`);
        const logs = await res.json();
        
        const listEl = document.getElementById('stats-activity-timeline');
        listEl.innerHTML = '';
        
        if (logs.length === 0) {
            listEl.innerHTML = '<div class="input-tip">No history logs recorded yet.</div>';
            return;
        }
        
        logs.forEach(log => {
            const item = document.createElement('div');
            item.className = 'activity-log-item';
            
            let iconClass = 'fa-plus act-created';
            let actionText = 'created';
            
            if (log.action === 'completed') {
                iconClass = 'fa-check act-completed';
                actionText = 'completed';
            } else if (log.action === 'deleted') {
                iconClass = 'fa-trash act-deleted';
                actionText = 'deleted';
            } else if (log.action === 'uncompleted') {
                iconClass = 'fa-rotate-left act-edited';
                actionText = 'uncompleted';
            } else if (log.action === 'unarchived') {
                iconClass = 'fa-rotate-left act-edited';
                actionText = 'unarchived';
            } else if (log.action === 'edited') {
                iconClass = 'fa-pencil act-edited';
                actionText = 'edited';
            } else if (log.action === 'project_created') {
                iconClass = 'fa-folder-plus act-created';
                actionText = 'created project';
            } else if (log.action === 'project_deleted') {
                iconClass = 'fa-folder-minus act-deleted';
                actionText = 'deleted project';
            }
            
            const timeFormatted = formatDateTimeDMY(new Date(log.timestamp + 'Z'));
            
            item.innerHTML = `
                <div class="activity-log-icon ${iconClass.split(' ')[1]}">
                    <i class="fa-solid ${iconClass.split(' ')[0]}"></i>
                </div>
                <div class="activity-log-details">
                    <div class="activity-log-title">
                        You <strong>${actionText}</strong> <code>${log.task_title}</code>
                        <span>in 📁${log.project}</span>
                    </div>
                    <div class="activity-log-time">${timeFormatted}</div>
                </div>
            `;
            
            listEl.appendChild(item);
        });
    } catch (err) {
        console.error("Error fetching logs:", err);
    }
}

function renderPriorityMatrix() {
    const todayStr = getTodayISO();
    
    // Helper to determine urgency
    const isUrgent = (task) => {
        const labels = task.labels || [];
        if (labels.includes('urgent')) return true;
        if (labels.includes('not-urgent')) return false;
        if (!task.due_date) return false;
        return task.due_date <= todayStr;
    };
    
    // Filter active (uncompleted) tasks
    const activeTasks = state.tasks.filter(t => !t.completed);
    
    // Group into 4 quadrants
    const q1 = []; // Urgent & Important (Priority 1 or 2 AND due today or overdue)
    const q2 = []; // Important & Not Urgent (Priority 1 or 2 AND not due today)
    const q3 = []; // Urgent & Not Important (Priority 3 or 4 AND due today or overdue)
    const q4 = []; // Not Important & Not Urgent (Priority 3 or 4 AND not due today)
    
    activeTasks.forEach(task => {
        const isImp = (task.priority === 1 || task.priority === 2);
        const isUrg = isUrgent(task);
        
        if (isImp && isUrg) q1.push(task);
        else if (isImp && !isUrg) q2.push(task);
        else if (!isImp && isUrg) q3.push(task);
        else q4.push(task);
    });
    
    // Sort each quadrant by due date, then by deadline
    const sortMatrixTasks = (arr) => {
        return arr.sort((a, b) => {
            const aDate = a.due_date || '9999-99-99';
            const bDate = b.due_date || '9999-99-99';
            if (aDate !== bDate) return aDate.localeCompare(bDate);
            
            const aDead = a.deadline || '99:99';
            const bDead = b.deadline || '99:99';
            return aDead.localeCompare(bDead);
        });
    };
    
    const quadrants = {
        'quadrant-q1-tasks': sortMatrixTasks(q1),
        'quadrant-q2-tasks': sortMatrixTasks(q2),
        'quadrant-q3-tasks': sortMatrixTasks(q3),
        'quadrant-q4-tasks': sortMatrixTasks(q4)
    };
    
    // Render each flow
    Object.keys(quadrants).forEach(flowId => {
        const flowEl = document.getElementById(flowId);
        if (!flowEl) return;
        flowEl.innerHTML = '';
        
        const tasksList = quadrants[flowId];
        
        if (tasksList.length === 0) {
            flowEl.innerHTML = `<div style="text-align:center; padding:16px; color:var(--text-muted); font-size:12px; font-style:italic;">No tasks in this quadrant</div>`;
            return;
        }
        
        tasksList.forEach(task => {
            const card = document.createElement('div');
            const prioColor = task.priority === 1 ? 'var(--prio-1)' : 
                             task.priority === 2 ? 'var(--prio-2)' : 
                             task.priority === 3 ? 'var(--prio-3)' : 'var(--prio-4)';
                             
            card.className = `task-item ${task.completed ? 'completed' : ''} ${task.deadline ? 'deadline-task' : ''}`;
            card.dataset.taskId = task.id;
            card.style.setProperty('--prio-color', prioColor);
            card.style.padding = '10px 14px'; // compact padding
            
            // Enable dragging
            card.draggable = true;
            card.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', task.id);
                e.dataTransfer.setData('source-project', task.project);
                e.dataTransfer.setData('source-view', 'matrix');
                card.classList.add('dragging');
            });
            card.addEventListener('dragend', () => {
                card.classList.remove('dragging');
            });
            
            // Build task date tag
            let tagsHtml = '';
            if (task.due_date) {
                const isLate = isOverdue(task.due_date) && !task.completed;
                tagsHtml += `
                    <span class="task-tag date-tag ${isLate ? 'overdue' : ''}" style="font-size:10px; padding:2px 6px;">
                        <i class="fa-regular fa-calendar"></i> ${formatDateFriendly(task.due_date)}
                    </span>
                `;
            }
            if (task.deadline) {
                tagsHtml += `
                    <span class="task-tag date-tag" style="font-size:10px; padding:2px 6px; background-color:rgba(255, 74, 74, 0.08); color:#FF6B6B; border: 1px solid rgba(255, 74, 74, 0.2);">
                        <i class="fa-solid fa-hourglass-half"></i> ${task.deadline}
                    </span>
                `;
            }
            
            card.innerHTML = `
                <div class="task-checkbox-container">
                    <button class="task-checkbox" onclick="event.stopPropagation(); toggleTaskComplete('${task.id}')" style="width:16px; height:16px; font-size:10px;">
                        <i class="fa-solid fa-check"></i>
                    </button>
                </div>
                <div class="task-details" onclick="openEditTaskModal('${task.id}')" style="flex-grow:1;">
                    <div class="task-title" style="font-size:13px; font-weight:500;">${task.title}</div>
                    <div class="task-meta" style="margin-top:4px; display:flex; flex-wrap:wrap; gap:4px;">
                        <span class="task-tag project-tag" style="font-size:10px; padding:2px 6px;">
                            <i class="fa-solid fa-folder-open"></i> ${task.project}
                        </span>
                        ${tagsHtml}
                    </div>
                </div>
            `;
            
            flowEl.appendChild(card);
        });
    });
}



// ----------------- BACKUPS RENDER -----------------
function renderBackups() {
    const listEl = document.getElementById('backup-list-rows');
    listEl.innerHTML = '';
    
    if (state.backups.length === 0) {
        listEl.innerHTML = '<tr><td colspan="4" style="text-align:center;" class="input-tip">No ZIP archives generated yet.</td></tr>';
        return;
    }
    
    state.backups.forEach(b => {
        const tr = document.createElement('tr');
        const timeFormatted = formatDateTimeDMY(new Date(b.created_at));
        
        tr.innerHTML = `
            <td><strong>${timeFormatted}</strong></td>
            <td><code style="color:var(--accent); font-weight:600;">${b.filename}</code></td>
            <td>${b.size_kb} KB</td>
            <td>
                <button class="btn btn-secondary-sm" onclick="triggerRestoreBackup('${b.filename}')">
                    <i class="fa-solid fa-rotate-left"></i> Restore Vault
                </button>
            </td>
        `;
        listEl.appendChild(tr);
    });
}

// ================= ACTION CONTROLLERS & SUBMISSIONS =================

// ----------------- TASK ACTIONS -----------------
const completingTimeouts = {};

async function toggleTaskComplete(taskId) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    
    const itemEl = document.querySelector(`.task-item[data-task-id="${taskId}"]`);
    if (!itemEl) return;
    
    if (completingTimeouts[taskId]) {
        // Undo completion!
        clearTimeout(completingTimeouts[taskId]);
        delete completingTimeouts[taskId];
        itemEl.classList.remove('completing');
        itemEl.querySelector('.task-checkbox').classList.remove('active');
        return;
    }
    
    // Start completing transition
    itemEl.classList.add('completing');
    itemEl.querySelector('.task-checkbox').classList.add('active');
    
    // 1.5 seconds delay before archiving or toggling complete
    completingTimeouts[taskId] = setTimeout(async () => {
        delete completingTimeouts[taskId];
        try {
            const shouldArchive = !state.settings || state.settings.auto_archive_completed !== false;
            let url = `${API_BASE}/tasks/${task.project}/${taskId}/archive`;
            if (!shouldArchive) {
                url = `${API_BASE}/tasks/${taskId}/toggle`;
            }
            const res = await fetch(url, {
                method: 'POST'
            });
            const result = await res.json();
            if (result.status === 'success') {
                await syncAllData();
            }
        } catch (err) {
            console.error("Error completing/archiving task:", err);
            itemEl.classList.remove('completing');
            itemEl.querySelector('.task-checkbox').classList.remove('active');
        }
    }, 1500);
}

async function triggerUnarchiveTask(project, taskId) {
    try {
        const res = await fetch(`${API_BASE}/tasks/${project}/${taskId}/unarchive`, {
            method: 'POST'
        });
        const result = await res.json();
        if (result.status === 'success') {
            await syncAllData();
            await renderAnalytics();
        } else {
            alert("Failed to unarchive task: " + (result.detail || "Unknown error"));
        }
    } catch (err) {
        console.error("Error unarchiving task:", err);
        alert("Error unarchiving task: " + err.message);
    }
}

async function triggerDeleteTask(project, taskId) {
    if (!confirm("Are you sure you want to permanently delete this task line from your Obsidian note?")) return;
    try {
        const res = await fetch(`${API_BASE}/tasks/${project}/${taskId}`, { method: 'DELETE' });
        const result = await res.json();
        if (result.status === 'success') {
            await syncAllData();
        }
    } catch (err) {
        console.error(err);
    }
}

// ----------------- PROJECT ACTIONS -----------------
async function triggerDeleteProject(projectName) {
    if (!confirm(`Warning: This will permanently delete the Markdown file "${projectName}.md" inside your vault. Proceed?`)) return;
    try {
        const res = await fetch(`${API_BASE}/projects/${projectName}`, { method: 'DELETE' });
        const result = await res.json();
        if (result.status === 'success') {
            if (state.activeProject === projectName) {
                switchView('inbox');
            } else {
                await syncAllData();
            }
        }
    } catch (err) {
        console.error(err);
    }
}

// ================= MODALS & EVENTS MANAGERS =================

async function updateSectionsDatalistForProject(projectName) {
    const datalist = document.getElementById('sections-list');
    datalist.innerHTML = '';
    try {
        const res = await fetch(`${API_BASE}/projects/${projectName}/sections`);
        const sections = await res.json();
        sections.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s;
            datalist.appendChild(opt);
        });
    } catch (err) {
        console.error("Error fetching sections for datalist:", err);
    }
}

function openAddTaskModal(defaultDate = null) {
    document.getElementById('task-modal-title').textContent = "Add New Task";
    document.getElementById('task-input-id').value = '';
    document.getElementById('task-input-title').value = '';
    document.getElementById('task-input-due').value = defaultDate || '';
    document.getElementById('task-input-deadline').value = '';
    
    const hasDeadline = document.getElementById('task-input-has-deadline');
    const deadlineTime = document.getElementById('task-input-deadline-time');
    if (hasDeadline) hasDeadline.checked = false;
    if (deadlineTime) {
        deadlineTime.value = '';
        deadlineTime.style.display = 'none';
    }
    
    document.getElementById('task-input-priority').value = '4';
    document.getElementById('task-input-recurring').value = '';
    document.getElementById('task-input-labels').value = '';
    document.getElementById('task-input-section').value = 'Default';
    
    // Hide comment editor block for new tasks
    document.getElementById('modal-comments-block').style.display = 'none';
    
    // Populate projects select
    const projSelect = document.getElementById('task-input-project');
    projSelect.innerHTML = '';
    state.projects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        opt.selected = state.activeProject === p.name || (state.activeView === 'inbox' && p.name === 'Inbox');
        projSelect.appendChild(opt);
    });
    
    // Fetch and populate sections datalist based on the active/selected project
    const currentProj = projSelect.value;
    if (currentProj) {
        updateSectionsDatalistForProject(currentProj);
    }
    
    document.getElementById('task-modal').style.display = 'flex';
    document.getElementById('task-input-title').focus();
}

let activeEditingTask = null;

function openEditTaskModal(taskId) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    
    activeEditingTask = task;
    
    document.getElementById('task-modal-title').textContent = "Edit Task";
    document.getElementById('task-input-id').value = task.id;
    document.getElementById('task-input-title').value = task.title;
    document.getElementById('task-input-due').value = task.due_date || '';
    document.getElementById('task-input-deadline').value = task.deadline || '';
    
    const hasDeadline = document.getElementById('task-input-has-deadline');
    const deadlineTime = document.getElementById('task-input-deadline-time');
    
    if (task.deadline) {
        if (hasDeadline) hasDeadline.checked = true;
        if (deadlineTime) {
            deadlineTime.style.display = 'block';
            let timeVal = "";
            if (task.deadline.includes(' ')) {
                timeVal = task.deadline.split(' ')[1];
            } else if (task.deadline.includes(':')) {
                timeVal = task.deadline;
            }
            deadlineTime.value = timeVal;
        }
    } else {
        if (hasDeadline) hasDeadline.checked = false;
        if (deadlineTime) {
            deadlineTime.style.display = 'none';
            deadlineTime.value = '';
        }
    }
    document.getElementById('task-input-priority').value = task.priority;
    document.getElementById('task-input-recurring').value = task.recurring || '';
    document.getElementById('task-input-labels').value = task.labels ? task.labels.join(', ') : '';
    document.getElementById('task-input-section').value = task.section || 'Default';
    
    // Show comments block
    document.getElementById('modal-comments-block').style.display = 'flex';
    renderModalComments(task.comments || []);
    
    // Populate projects select
    const projSelect = document.getElementById('task-input-project');
    projSelect.innerHTML = '';
    state.projects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        opt.selected = task.project === p.name;
        projSelect.appendChild(opt);
    });
    
    // Fetch and populate sections datalist based on the task's project
    updateSectionsDatalistForProject(task.project);
    
    document.getElementById('task-modal').style.display = 'flex';
    document.getElementById('task-input-title').focus();
}

function renderModalComments(comments) {
    const list = document.getElementById('modal-comments-list-items');
    list.innerHTML = '';
    
    if (comments.length === 0) {
        list.innerHTML = '<div class="input-tip">No comments yet. Write a note below!</div>';
        return;
    }
    
    comments.forEach(c => {
        const div = document.createElement('div');
        div.className = 'comment-item';
        div.textContent = c;
        list.appendChild(div);
    });
}

function closeTaskModal() {
    document.getElementById('task-modal').style.display = 'none';
    activeEditingTask = null;
}

// ----------------- BACKUP RESTORE HANDLER -----------------
async function triggerRestoreBackup(filename) {
    if (!confirm(`CRITICAL WARNING: This will completely replace your current vault files with the contents of "${filename}". You might lose any modifications made after the backup date. Proceed?`)) return;
    
    showSyncBanner();
    try {
        const res = await fetch(`${API_BASE}/backups/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename })
        });
        const result = await res.json();
        if (result.status === 'success') {
            alert("Obsidian database rolled back and restored successfully!");
            await syncAllData();
        } else {
            alert("Error: " + result.detail);
        }
    } catch (err) {
        console.error(err);
    } finally {
        hideSyncBanner();
    }
}

// ================= EVENT LISTENERS SETUP =================
function setupEventListeners() {
    // Sidebar navigation
    document.querySelectorAll('.sidebar .nav-item').forEach(item => {
        item.onclick = () => {
            const view = item.dataset.view;
            switchView(view);
        };
    });
    
    // Toggle sidebar on mobile
    document.getElementById('sidebar-toggle').onclick = () => {
        document.getElementById('app-sidebar').classList.add('active');
    };
    
    // Close sidebar click outside
    document.addEventListener('click', (e) => {
        const sidebar = document.getElementById('app-sidebar');
        const toggle = document.getElementById('sidebar-toggle');
        if (window.innerWidth <= 992 && sidebar.classList.contains('active')) {
            if (!sidebar.contains(e.target) && !toggle.contains(e.target)) {
                sidebar.classList.remove('active');
            }
        }
    });
    
    // Quick Add Button bindings
    document.getElementById('sidebar-quick-add-btn').onclick = () => openAddTaskModal();
    document.getElementById('header-quick-add-btn').onclick = () => openAddTaskModal();
    
    // Modal cancel buttons
    document.getElementById('btn-task-modal-close').onclick = closeTaskModal;
    document.getElementById('btn-task-modal-cancel').onclick = closeTaskModal;
    
    // Quick add input text parser hooks
    const titleInput = document.getElementById('task-input-title');
    titleInput.onblur = () => {
        const text = titleInput.value.trim();
        // Only run natural language parser for new tasks when we lose focus
        if (text && !document.getElementById('task-input-id').value) {
            const parsed = parseNaturalLanguageTask(text);
            titleInput.value = parsed.title;
            if (parsed.priority) document.getElementById('task-input-priority').value = parsed.priority;
            if (parsed.due_date) document.getElementById('task-input-due').value = parsed.due_date;
            if (parsed.recurring) document.getElementById('task-input-recurring').value = parsed.recurring;
            if (parsed.labels.length > 0) {
                const labelsInput = document.getElementById('task-input-labels');
                labelsInput.value = parsed.labels.join(', ');
            }
        }
    };
    
    // Update sections datalist when project changes
    document.getElementById('task-input-project').onchange = (e) => {
        const selectedProject = e.target.value;
        if (selectedProject) {
            updateSectionsDatalistForProject(selectedProject);
        }
    };
    
    // Sync deadline elements
    document.getElementById('task-input-has-deadline').onchange = syncDeadlineInputs;
    document.getElementById('task-input-deadline-time').onchange = syncDeadlineInputs;
    document.getElementById('task-input-deadline-time').oninput = syncDeadlineInputs;
    document.getElementById('task-input-due').onchange = syncDeadlineInputs;
    document.getElementById('task-input-due').oninput = syncDeadlineInputs;
    
    // Task modal submit
    document.getElementById('task-form').onsubmit = async (e) => {
        e.preventDefault();
        
        const id = document.getElementById('task-input-id').value || '^' + Math.random().toString(36).substring(2, 8);
        const title = titleInput.value.trim();
        const due_date = document.getElementById('task-input-due').value || null;
        const deadline = document.getElementById('task-input-deadline').value.trim() || null;
        const priority = parseInt(document.getElementById('task-input-priority').value);
        const recurring = document.getElementById('task-input-recurring').value.trim() || null;
        const project = document.getElementById('task-input-project').value;
        const section = document.getElementById('task-input-section').value.trim() || 'Default';
        
        const rawLabels = document.getElementById('task-input-labels').value;
        const labels = rawLabels ? rawLabels.split(',').map(l => l.trim()).filter(Boolean) : [];
        
        // Preserve comments if editing
        const comments = activeEditingTask ? activeEditingTask.comments : [];
        const completed = activeEditingTask ? activeEditingTask.completed : false;
        
        const taskPayload = {
            id: id.startsWith('^') ? id.substring(1) : id,
            title,
            completed,
            priority,
            due_date,
            deadline,
            recurring,
            labels,
            project,
            section,
            comments,
            indent_level: activeEditingTask ? activeEditingTask.indent_level : 0
        };
        
        try {
            const res = await fetch(`${API_BASE}/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(taskPayload)
            });
            const result = await res.json();
            if (result.status === 'success') {
                closeTaskModal();
                await syncAllData();
            }
        } catch (err) {
            console.error(err);
        }
    };
    
    // Add Note comment button inside Edit modal
    document.getElementById('btn-add-modal-comment').onclick = () => {
        const input = document.getElementById('task-new-comment-input');
        const comment = input.value.trim();
        if (comment && activeEditingTask) {
            if (!activeEditingTask.comments) activeEditingTask.comments = [];
            activeEditingTask.comments.push(comment);
            
            // Re-render modal list
            renderModalComments(activeEditingTask.comments);
            input.value = '';
        }
    };
    
    // Add Project Modal binds
    document.getElementById('add-project-btn').onclick = () => {
        document.getElementById('project-input-name').value = '';
        document.getElementById('project-modal').style.display = 'flex';
        document.getElementById('project-input-name').focus();
    };
    
    document.getElementById('btn-project-modal-close').onclick = () => document.getElementById('project-modal').style.display = 'none';
    document.getElementById('btn-project-modal-cancel').onclick = () => document.getElementById('project-modal').style.display = 'none';
    
    document.getElementById('project-form').onsubmit = async (e) => {
        e.preventDefault();
        const name = document.getElementById('project-input-name').value.trim();
        if (!name) return;
        
        try {
            const res = await fetch(`${API_BASE}/projects`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            const result = await res.json();
            if (result.status === 'success') {
                document.getElementById('project-modal').style.display = 'none';
                await syncAllData();
                switchView('project', name);
            } else {
                alert("Error: " + result.detail);
            }
        } catch (err) {
            console.error(err);
        }
    };
    
    // Filter desk buttons
    document.getElementById('btn-run-query').onclick = runFilterQuery;
    document.getElementById('filter-query-input').onkeypress = (e) => {
        if (e.key === 'Enter') runFilterQuery();
    };
    
    // Backups triggers
    document.getElementById('btn-create-backup').onclick = async () => {
        showSyncBanner();
        try {
            const res = await fetch(`${API_BASE}/backups`, { method: 'POST' });
            const result = await res.json();
            if (result.status === 'success') {
                alert("Manual ZIP backup compiled in backups/ folder successfully!");
                await fetchBackups();
            }
        } catch (err) {
            console.error(err);
        } finally {
            hideSyncBanner();
        }
    };
    
    // Calendar buttons
    document.getElementById('cal-prev-month').onclick = () => {
        calendarCurrentDate.setMonth(calendarCurrentDate.getMonth() - 1);
        renderCalendar();
    };
    document.getElementById('cal-next-month').onclick = () => {
        calendarCurrentDate.setMonth(calendarCurrentDate.getMonth() + 1);
        renderCalendar();
    };
    
    // Save Settings
    document.getElementById('settings-form').onsubmit = async (e) => {
        e.preventDefault();
        
        const obsidian_vault_path = document.getElementById('setting-vault-path').value.trim();
        const daily_goal = 5;
        const weekly_goal = 30;
        const ollama_url = document.getElementById('setting-ollama-url').value.trim();
        const ollama_model = document.getElementById('setting-ollama-model').value.trim();
        const week_start = document.getElementById('setting-week-start').value;
        const task_sort_order = document.getElementById('setting-task-sort').value;
        const carry_over_overdue = document.getElementById('setting-carry-over').value === 'true';
        const auto_archive_completed = document.getElementById('setting-archive-behavior').value === 'true';
        const ai_custom_instructions = document.getElementById('setting-ai-instructions').value;
        
        // Find active theme selection
        const activeThemeOption = document.querySelector('.theme-option.active');
        const theme = activeThemeOption ? activeThemeOption.dataset.theme : 'atreus-snow';
        
        showSyncBanner();
        try {
            const res = await fetch(`${API_BASE}/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    obsidian_vault_path,
                    daily_goal,
                    weekly_goal,
                    theme,
                    ollama_url,
                    ollama_model,
                    week_start,
                    task_sort_order,
                    carry_over_overdue,
                    auto_archive_completed,
                    ai_custom_instructions
                })
            });
            
            const result = await res.json();
            if (result.status === 'success') {
                state.settings = {
                    obsidian_vault_path,
                    daily_goal,
                    weekly_goal,
                    theme,
                    ollama_url,
                    ollama_model,
                    week_start,
                    task_sort_order,
                    carry_over_overdue,
                    auto_archive_completed,
                    ai_custom_instructions
                };
                alert("Vault configurations saved successfully!");
                await syncAllData();
            } else {
                alert("Error saving settings: " + result.detail);
            }
        } catch (err) {
            console.error(err);
        } finally {
            hideSyncBanner();
        }
    };
    
    // Theme options selector
    document.querySelectorAll('.theme-option').forEach(opt => {
        opt.onclick = () => {
            const theme = opt.dataset.theme;
            applyTheme(theme);
        };
    });
    
    // Export Template Button click
    document.getElementById('btn-export-template').onclick = async () => {
        if (!state.activeProject) return;
        
        try {
            const res = await fetch(`${API_BASE}/templates/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ project_name: state.activeProject })
            });
            const result = await res.json();
            if (result.status === 'success') {
                alert(`Exported "${state.activeProject}.md" project template to templates/ folder! (Staged as clean checklist template).`);
            }
        } catch (err) {
            console.error(err);
        }
    };
    
    // Setup Eisenhower Matrix drop zones
    document.querySelectorAll('.matrix-quadrant').forEach(quadrant => {
        quadrant.addEventListener('dragover', (e) => {
            e.preventDefault();
            quadrant.classList.add('drag-over');
        });
        
        quadrant.addEventListener('dragleave', () => {
            quadrant.classList.remove('drag-over');
        });
        
        quadrant.addEventListener('drop', async (e) => {
            e.preventDefault();
            quadrant.classList.remove('drag-over');
            
            const taskId = e.dataTransfer.getData('text/plain');
            const task = state.tasks.find(t => t.id === taskId);
            if (!task) return;
            
            const todayStr = getTodayISO();
            const tomorrowStr = getTomorrowISO();
            
            // Determine quadrant based on classes
            let quadrantId = '';
            if (quadrant.classList.contains('q-urgent-important')) quadrantId = 'q1';
            else if (quadrant.classList.contains('q-not-urgent-important')) quadrantId = 'q2';
            else if (quadrant.classList.contains('q-urgent-not-important')) quadrantId = 'q3';
            else if (quadrant.classList.contains('q-not-urgent-not-important')) quadrantId = 'q4';
            
            let labels = task.labels || [];
            
            if (quadrantId === 'q1') {
                task.priority = 1;
                if (!labels.includes('urgent')) labels.push('urgent');
                if (!labels.includes('important')) labels.push('important');
                labels = labels.filter(l => l !== 'not-urgent');
            } else if (quadrantId === 'q2') {
                task.priority = 2;
                if (!labels.includes('important')) labels.push('important');
                if (!labels.includes('not-urgent')) labels.push('not-urgent');
                labels = labels.filter(l => l !== 'urgent');
            } else if (quadrantId === 'q3') {
                task.priority = 3;
                if (!labels.includes('urgent')) labels.push('urgent');
                labels = labels.filter(l => l !== 'important' && l !== 'not-urgent');
            } else if (quadrantId === 'q4') {
                task.priority = 4;
                if (!labels.includes('not-urgent')) labels.push('not-urgent');
                labels = labels.filter(l => l !== 'urgent' && l !== 'important');
            }
            
            task.labels = labels;
            
            try {
                const res = await fetch(`${API_BASE}/tasks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(task)
                });
                const result = await res.json();
                if (result.status === 'success') {
                    await syncAllData();
                }
            } catch (err) {
                console.error("Error saving task priority via matrix drag-and-drop:", err);
            }
        });
    });
    
    // Setup Inbox navigation drop zone
    const navInbox = document.getElementById('nav-inbox');
    if (navInbox) {
        navInbox.addEventListener('dragover', (e) => {
            e.preventDefault();
            navInbox.classList.add('drag-over');
        });
        
        navInbox.addEventListener('dragleave', () => {
            navInbox.classList.remove('drag-over');
        });
        
        navInbox.addEventListener('drop', async (e) => {
            e.preventDefault();
            navInbox.classList.remove('drag-over');
            
            const taskId = e.dataTransfer.getData('text/plain');
            const task = state.tasks.find(t => t.id === taskId);
            if (!task) return;
            
            task.project = 'Inbox';
            task.section = ''; // Reset section to top-level of Inbox
            
            try {
                const res = await fetch(`${API_BASE}/tasks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(task)
                });
                const result = await res.json();
                if (result.status === 'success') {
                    await syncAllData();
                }
            } catch (err) {
                console.error("Error moving task to Inbox via drag-and-drop:", err);
            }
        });
    }
    
    // Add Template import binds (e.g. from template)
    // Wait, let's create a template trigger in UI if they click a "New Project from Template" button.
    // For simplicity, we can load templates when opening the Add Project modal, or let them do it easily.
    setupAIChatEventListeners();
    setupContextMenu();

    // Toggle "View more" popover inside the footer
    const viewMoreBtn = document.getElementById('nav-view-more');
    const viewMorePopover = document.getElementById('view-more-popover');
    if (viewMoreBtn && viewMorePopover) {
        viewMoreBtn.onclick = (e) => {
            e.stopPropagation();
            const isShown = viewMorePopover.style.display === 'block';
            viewMorePopover.style.display = isShown ? 'none' : 'block';
        };
        
        document.addEventListener('click', (e) => {
            if (!viewMoreBtn.contains(e.target)) {
                viewMorePopover.style.display = 'none';
            }
        });
    }
}

// ================= AI ASSISTANT CHAT CONTROLLER =================
let aiMessagesHistory = [];

function setupAIChatEventListeners() {
    const toggleBtn = document.getElementById('ai-chat-toggle');
    const closeBtn = document.getElementById('ai-chat-close');
    const sendBtn = document.getElementById('ai-chat-send');
    const inputField = document.getElementById('ai-chat-input');
    const panel = document.getElementById('ai-chat-panel');
    
    toggleBtn.onclick = () => {
        if (panel.style.display === 'none') {
            panel.style.display = 'flex';
            inputField.focus();
        } else {
            panel.style.display = 'none';
        }
    };
    
    closeBtn.onclick = () => {
        panel.style.display = 'none';
    };
    
    sendBtn.onclick = handleSendAIChat;
    inputField.onkeypress = (e) => {
        if (e.key === 'Enter') handleSendAIChat();
    };
    
    // Suggestion chips listeners
    document.querySelectorAll('.ai-suggest-chip').forEach(chip => {
        chip.onclick = () => {
            const promptText = chip.dataset.prompt;
            inputField.value = promptText;
            handleSendAIChat();
        };
    });
}

async function handleSendAIChat() {
    const inputField = document.getElementById('ai-chat-input');
    const text = inputField.value.trim();
    if (!text) return;
    
    inputField.value = '';
    
    const container = document.getElementById('ai-chat-messages-container');
    
    // 1. Append User Message
    appendAIChatBubble(text, 'user');
    
    // Update history
    aiMessagesHistory.push({ role: 'user', content: text });
    
    // 2. Append Typing Loader
    const loader = appendAITypingLoader();
    container.scrollTop = container.scrollHeight;
    
    try {
        const res = await fetch(`${API_BASE}/assistant/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: aiMessagesHistory })
        });
        const result = await res.json();
        
        // Remove Loader
        loader.remove();
        
        // 3. Append Assistant Response
        appendAIChatBubble(result.response, 'system');
        
        // Update history
        aiMessagesHistory.push({ role: 'assistant', content: result.response });
        
        // Limit history size
        if (aiMessagesHistory.length > 10) {
            aiMessagesHistory = aiMessagesHistory.slice(-10);
        }
        
    } catch (err) {
        loader.remove();
        appendAIChatBubble("I encountered an unexpected network error. Please verify the homeserver is running.", 'error');
        console.error(err);
    }
    
    container.scrollTop = container.scrollHeight;
}

function appendAIChatBubble(text, sender) {
    const container = document.getElementById('ai-chat-messages-container');
    const div = document.createElement('div');
    div.className = `ai-msg ai-msg-${sender}`;
    
    // Basic Markdown to HTML parsing for nice bullets and bold text!
    let html = text
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`(.*?)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br>');
        
    div.innerHTML = html;
    container.appendChild(div);
}

function appendAITypingLoader() {
    const container = document.getElementById('ai-chat-messages-container');
    const div = document.createElement('div');
    div.className = 'ai-msg ai-msg-system';
    
    div.innerHTML = `
        <div class="ai-typing-loader">
            <span></span><span></span><span></span>
        </div>
    `;
    container.appendChild(div);
    return div;
}

// ================= CUSTOM CONTEXT MENU CONTROLLER =================

function syncDeadlineInputs() {
    const hasDeadline = document.getElementById('task-input-has-deadline');
    const deadlineTime = document.getElementById('task-input-deadline-time');
    const dueInput = document.getElementById('task-input-due');
    const hiddenDeadline = document.getElementById('task-input-deadline');
    
    if (!hasDeadline || !deadlineTime || !dueInput || !hiddenDeadline) return;
    
    if (hasDeadline.checked) {
        deadlineTime.style.display = 'block';
        
        let timeVal = deadlineTime.value;
        if (!timeVal) {
            timeVal = '12:00';
            deadlineTime.value = '12:00';
        }
        
        let dueVal = dueInput.value;
        if (!dueVal) {
            dueVal = getTodayISO();
            dueInput.value = dueVal;
        }
        
        hiddenDeadline.value = `${dueVal} ${timeVal}`;
    } else {
        deadlineTime.style.display = 'none';
        hiddenDeadline.value = '';
    }
}

function getNextWeekISO() {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().split('T')[0];
}

async function updateTaskSingleField(taskId, updates) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    
    const taskPayload = {
        ...task,
        ...updates
    };
    
    try {
        const res = await fetch(`${API_BASE}/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(taskPayload)
        });
        const result = await res.json();
        if (result.status === 'success') {
            await syncAllData();
        }
    } catch (err) {
        console.error("Error updating task field:", err);
    }
}

function promptCustomDueDate(taskId, currentVal) {
    const val = prompt("Enter due date (YYYY-MM-DD):", currentVal);
    if (val === null) return;
    const trimmed = val.trim();
    if (trimmed === '') {
        updateTaskSingleField(taskId, { due_date: null });
    } else {
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
            updateTaskSingleField(taskId, { due_date: trimmed });
        } else {
            alert("Invalid date format. Please use YYYY-MM-DD.");
        }
    }
}

async function duplicateTask(taskId) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    
    const copyId = Math.random().toString(36).substring(2, 8);
    const taskPayload = {
        ...task,
        id: copyId,
        title: task.title
    };
    
    try {
        const res = await fetch(`${API_BASE}/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(taskPayload)
        });
        const result = await res.json();
        if (result.status === 'success') {
            await syncAllData();
        }
    } catch (err) {
        console.error("Error duplicating task:", err);
    }
}

function getContextMenuElement() {
    let menuEl = document.getElementById('custom-context-menu');
    if (!menuEl) {
        menuEl = document.createElement('div');
        menuEl.id = 'custom-context-menu';
        menuEl.className = 'context-menu';
        menuEl.style.position = 'fixed';
        menuEl.style.zIndex = '10000';
        document.body.appendChild(menuEl);
    }
    return menuEl;
}

function hideContextMenu() {
    const menuEl = document.getElementById('custom-context-menu');
    if (menuEl) {
        menuEl.style.display = 'none';
    }
}

function positionAndShowMenu(e, menuEl) {
    menuEl.style.display = 'block';
    menuEl.style.visibility = 'hidden';
    
    const menuWidth = menuEl.offsetWidth;
    const menuHeight = menuEl.offsetHeight;
    
    menuEl.style.visibility = 'visible';
    menuEl.style.display = 'none';
    
    let posX = e.clientX;
    let posY = e.clientY;
    
    if (posX + menuWidth > window.innerWidth) {
        posX = window.innerWidth - menuWidth - 10;
    }
    if (posY + menuHeight > window.innerHeight) {
        posY = window.innerHeight - menuHeight - 10;
    }
    
    if (posX < 10) posX = 10;
    if (posY < 10) posY = 10;
    
    menuEl.classList.remove('submenu-left');
    if (posX + menuWidth + 190 > window.innerWidth) {
        menuEl.classList.add('submenu-left');
    }
    
    menuEl.style.left = posX + 'px';
    menuEl.style.top = posY + 'px';
    menuEl.style.display = 'block';
}

function showTaskContextMenu(e, taskId) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    
    const menuEl = getContextMenuElement();
    
    const projectsSubmenuHtml = state.projects.map(p => `
        <li class="context-menu-item" onclick="updateTaskSingleField('${taskId}', { project: '${p.name.replace(/'/g, "\\'")}', section: '' })">
            <span class="menu-label">
                <i class="fa-solid fa-folder-open" style="color:var(--accent);"></i>
                ${p.name}
            </span>
        </li>
    `).join('');

    menuEl.innerHTML = `
        <li class="context-menu-item" onclick="openEditTaskModal('${taskId}')">
            <span class="menu-label">
                <i class="fa-regular fa-pen-to-square"></i> Edit Task
            </span>
        </li>
        <li class="context-menu-item" onclick="toggleTaskComplete('${taskId}')">
            <span class="menu-label">
                <i class="fa-solid fa-check-circle"></i> 
                ${task.completed ? 'Mark Uncomplete' : 'Complete Task'}
            </span>
        </li>
        
        <div class="context-menu-divider"></div>
        
        <li class="context-menu-item">
            <span class="menu-label">
                <i class="fa-solid fa-flag" style="color: var(--prio-${task.priority});"></i> Priority
            </span>
            <i class="fa-solid fa-chevron-right submenu-arrow"></i>
            <ul class="context-menu-submenu">
                <li class="context-menu-item" onclick="updateTaskSingleField('${taskId}', { priority: 1 })">
                    <span class="menu-label"><i class="fa-solid fa-flag" style="color: var(--prio-1);"></i> Priority 1</span>
                </li>
                <li class="context-menu-item" onclick="updateTaskSingleField('${taskId}', { priority: 2 })">
                    <span class="menu-label"><i class="fa-solid fa-flag" style="color: var(--prio-2);"></i> Priority 2</span>
                </li>
                <li class="context-menu-item" onclick="updateTaskSingleField('${taskId}', { priority: 3 })">
                    <span class="menu-label"><i class="fa-solid fa-flag" style="color: var(--prio-3);"></i> Priority 3</span>
                </li>
                <li class="context-menu-item" onclick="updateTaskSingleField('${taskId}', { priority: 4 })">
                    <span class="menu-label"><i class="fa-solid fa-flag" style="color: var(--prio-4);"></i> Priority 4</span>
                </li>
            </ul>
        </li>
        
        <li class="context-menu-item">
            <span class="menu-label">
                <i class="fa-regular fa-calendar"></i> Due Date
            </span>
            <i class="fa-solid fa-chevron-right submenu-arrow"></i>
            <ul class="context-menu-submenu">
                <li class="context-menu-item" onclick="updateTaskSingleField('${taskId}', { due_date: getTodayISO() })">
                    <span class="menu-label"><i class="fa-solid fa-calendar-day" style="color: #2ECC71;"></i> Today</span>
                </li>
                <li class="context-menu-item" onclick="updateTaskSingleField('${taskId}', { due_date: getTomorrowISO() })">
                    <span class="menu-label"><i class="fa-solid fa-sun" style="color: #FFA04A;"></i> Tomorrow</span>
                </li>
                <li class="context-menu-item" onclick="updateTaskSingleField('${taskId}', { due_date: getNextWeekISO() })">
                    <span class="menu-label"><i class="fa-solid fa-calendar-days" style="color: #9A4BFF;"></i> Next Week</span>
                </li>
                <li class="context-menu-item" onclick="updateTaskSingleField('${taskId}', { due_date: null })">
                    <span class="menu-label"><i class="fa-solid fa-calendar-minus" style="color: var(--text-muted);"></i> No Date</span>
                </li>
                <div class="context-menu-divider"></div>
                <li class="context-menu-item" onclick="promptCustomDueDate('${taskId}', '${task.due_date || ''}')">
                    <span class="menu-label"><i class="fa-regular fa-calendar-plus"></i> Custom...</span>
                </li>
            </ul>
        </li>
        
        <li class="context-menu-item">
            <span class="menu-label">
                <i class="fa-solid fa-arrows-spin"></i> Move to Project
            </span>
            <i class="fa-solid fa-chevron-right submenu-arrow"></i>
            <ul class="context-menu-submenu" style="max-height: 250px; overflow-y: auto;">
                ${projectsSubmenuHtml}
            </ul>
        </li>
        
        <div class="context-menu-divider"></div>
        
        <li class="context-menu-item" onclick="duplicateTask('${taskId}')">
            <span class="menu-label">
                <i class="fa-regular fa-copy"></i> Duplicate
            </span>
        </li>
        
        <li class="context-menu-item" onclick="triggerDeleteTask('${task.project.replace(/'/g, "\\'")}', '${taskId}')">
            <span class="menu-label" style="color: var(--prio-1);">
                <i class="fa-regular fa-trash-can" style="color: var(--prio-1);"></i> Delete Task
            </span>
        </li>
    `;
    
    positionAndShowMenu(e, menuEl);
}

function showProjectContextMenu(e, projectName) {
    const menuEl = getContextMenuElement();
    
    if (projectName === 'Inbox') {
        menuEl.innerHTML = `
            <li class="context-menu-item" onclick="switchView('inbox')">
                <span class="menu-label">
                    <i class="fa-solid fa-inbox" style="color:var(--accent);"></i> Open Inbox
                </span>
            </li>
            <li class="context-menu-item" onclick="openAddTaskModalForSection('Inbox', 'Default')">
                <span class="menu-label">
                    <i class="fa-solid fa-plus"></i> Add Task
                </span>
            </li>
        `;
    } else {
        menuEl.innerHTML = `
            <li class="context-menu-item" onclick="switchView('project', '${projectName.replace(/'/g, "\\'")}')">
                <span class="menu-label">
                    <i class="fa-solid fa-folder-open" style="color:var(--accent);"></i> Open Project
                </span>
            </li>
            <li class="context-menu-item" onclick="openAddTaskModalForSection('${projectName.replace(/'/g, "\\'")}', 'Default')">
                <span class="menu-label">
                    <i class="fa-solid fa-plus"></i> Add Task
                </span>
            </li>
            <li class="context-menu-item" onclick="triggerAddSection('${projectName.replace(/'/g, "\\'")}')">
                <span class="menu-label">
                    <i class="fa-solid fa-circle-plus"></i> Add Section
                </span>
            </li>
            <div class="context-menu-divider"></div>
            <li class="context-menu-item" onclick="triggerDeleteProject('${projectName.replace(/'/g, "\\'")}')">
                <span class="menu-label" style="color: var(--prio-1);">
                    <i class="fa-regular fa-trash-can" style="color: var(--prio-1);"></i> Delete Project
                </span>
            </li>
        `;
    }
    
    positionAndShowMenu(e, menuEl);
}

function setupContextMenu() {
    document.addEventListener('contextmenu', (e) => {
        const taskItem = e.target.closest('.task-item');
        const projectItem = e.target.closest('.project-item');
        const inboxItem = e.target.closest('#nav-inbox');

        if (taskItem) {
            e.preventDefault();
            showTaskContextMenu(e, taskItem.dataset.taskId);
        } else if (projectItem) {
            e.preventDefault();
            showProjectContextMenu(e, projectItem.dataset.project);
        } else if (inboxItem) {
            e.preventDefault();
            showProjectContextMenu(e, 'Inbox');
        } else {
            hideContextMenu();
        }
    });

    document.addEventListener('click', (e) => {
        const menuItem = e.target.closest('.context-menu-item');
        if (!e.target.closest('#custom-context-menu') || (menuItem && !menuItem.querySelector('.context-menu-submenu'))) {
            hideContextMenu();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideContextMenu();
        }
    });
}

// ================= WORKLOAD HEATMAP ENGINE =================

function renderWorkloadMap() {
    const container = document.getElementById('view-workload');
    if (!container) return;
    
    // Re-populate projects filter dropdown
    const filterSelect = document.getElementById('workload-project-filter');
    const selectedProj = filterSelect ? filterSelect.value : 'all';
    
    // Fill container view skeleton
    container.innerHTML = `
        <div class="workload-container" style="padding: 4px;">
            <div class="workload-header-row" style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 24px; gap:16px; flex-wrap: wrap;">
                <div class="workload-info">
                    <h3 style="font-family:var(--font-heading); font-size:18px; margin:0 0 4px 0; color:var(--text-primary);">Overlapping Task Commitments</h3>
                    <p style="color:var(--text-secondary); font-size:13px; margin:0;">Identify calendar bottlenecks and dates with overlapping due dates/deadlines.</p>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <label for="workload-project-filter" style="font-size:13px; color:var(--text-secondary); margin:0; white-space:nowrap;">Filter by Project:</label>
                    <select id="workload-project-filter" class="form-control" style="width:180px; height:34px; padding: 4px 8px; border-radius: var(--border-radius-sm); border: 1px solid var(--border-color); background: var(--bg-input); color: var(--text-primary); cursor:pointer;">
                        <option value="all">All Projects</option>
                        ${state.projects.map(p => `<option value="${p.name}" ${selectedProj === p.name ? 'selected' : ''}>${p.name}</option>`).join('')}
                    </select>
                </div>
            </div>
            
            <!-- Heatmap Card -->
            <div class="workload-heatmap-card" style="background:var(--bg-card); border:1px solid var(--border-color); border-radius:var(--border-radius-lg); padding:24px; box-shadow:var(--shadow-md); margin-bottom:24px; overflow-x:auto;">
                <div class="heatmap-wrapper" style="display:flex; gap:10px; min-width: 1220px; position:relative; padding-top: 22px; height:185px;">
                    <!-- Weekday labels -->
                    <div class="heatmap-weekdays" style="display:grid; grid-template-rows: repeat(7, 16px); gap:6px; font-size:10px; color:var(--text-muted); padding-top: 2px; text-align:right; width: 36px; line-height: 16px;">
                        ${(state.settings && state.settings.week_start) === 'monday' ?
                            '<div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div><div>Sun</div>' :
                            '<div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div>'}
                    </div>
                    <!-- Heatmap grid column container -->
                    <div style="display:flex; flex-direction:column; gap:6px; flex-grow:1;">
                        <!-- Month labels row -->
                        <div id="heatmap-months" style="display:flex; font-size:9.5px; color:var(--text-muted); height: 16px; position:absolute; top:0; left:0; width:100%;">
                            <!-- Dynamically populated monthly headers -->
                        </div>
                        <!-- Days Grid columns -->
                        <div id="heatmap-grid" style="display:flex; gap:6px; margin-top: 4px;">
                            <!-- Dynamically populated columns of weeks -->
                        </div>
                    </div>
                </div>
                
                <!-- Legend -->
                <div class="heatmap-legend" style="display:flex; align-items:center; justify-content:flex-end; gap:6px; font-size:10px; color:var(--text-secondary); margin-top:16px;">
                    <span>Less</span>
                    <div style="width:10px; height:10px; background:rgba(255, 255, 255, 0.04); border:1px solid var(--border-color); border-radius:2px;"></div>
                    <div style="width:10px; height:10px; background:var(--accent); opacity:0.25; border-radius:2px;"></div>
                    <div style="width:10px; height:10px; background:var(--accent); opacity:0.5; border-radius:2px;"></div>
                    <div style="width:10px; height:10px; background:var(--accent); opacity:0.75; border-radius:2px;"></div>
                    <div style="width:10px; height:10px; background:var(--accent); opacity:1.0; border-radius:2px;"></div>
                    <span>More</span>
                </div>
            </div>
            
            <!-- Overlapping bottlenecks list -->
            <div class="workload-bottlenecks-card" style="background:var(--bg-card); border:1px solid var(--border-color); border-radius:var(--border-radius-lg); padding:24px; box-shadow:var(--shadow-md);">
                <h4 style="font-family:var(--font-heading); font-size:15px; margin:0 0 16px 0; color:var(--text-primary); display:flex; align-items:center; gap:8px;">
                    <i class="fa-solid fa-triangle-exclamation" style="color:#FFA04A;"></i> Detailed Bottlenecks (Overlapping Commitments)
                </h4>
                <div id="workload-bottlenecks-list" style="display:flex; flex-direction:column; gap:12px;">
                    <!-- Dynamically populated bottleneck item cards -->
                </div>
            </div>
        </div>
    `;
    
    // Bind project filter select
    document.getElementById('workload-project-filter').onchange = () => {
        renderWorkloadMap();
    };
    
    // Filter active tasks
    const activeProjectName = document.getElementById('workload-project-filter').value;
    const filteredTasks = state.tasks.filter(t => {
        if (t.completed) return false;
        if (activeProjectName !== 'all') {
            return t.project === activeProjectName;
        }
        return true;
    });
    // Helper to calculate difference in days
    function getDaysDiff(dateStr1, dateStr2) {
        const d1 = new Date(dateStr1);
        const d2 = new Date(dateStr2);
        d1.setHours(0,0,0,0);
        d2.setHours(0,0,0,0);
        return Math.round((d1 - d2) / (1000 * 60 * 60 * 24));
    }

    // Heatmap grid calculations
    const year = 2026;
    const jan1 = new Date(year, 0, 1);
    const isMondayStart = (state.settings && state.settings.week_start) === 'monday';
    const startDayOffset = isMondayStart ? (jan1.getDay() + 6) % 7 : jan1.getDay();
    const startDate = new Date(year, 0, 1 - startDayOffset);
    
    const gridEl = document.getElementById('heatmap-grid');
    const monthsEl = document.getElementById('heatmap-months');
    gridEl.innerHTML = '';
    monthsEl.innerHTML = '';
    
    let lastMonth = -1;
    const bottlenecks = {};
    
    for (let col = 0; col < 53; col++) {
        const colDiv = document.createElement('div');
        colDiv.className = 'heatmap-column';
        colDiv.style.display = 'flex';
        colDiv.style.flexDirection = 'column';
        colDiv.style.gap = '6px';
        colDiv.style.flexShrink = '0';
        
        for (let row = 0; row < 7; row++) {
            const currDate = new Date(startDate.getTime());
            currDate.setDate(startDate.getDate() + col * 7 + row);
            
            const iso = currDate.toISOString().split('T')[0];
            const isCurrentYear = currDate.getFullYear() === year;
            
            const square = document.createElement('div');
            square.className = 'heatmap-day';
            square.style.width = '16px';
            square.style.height = '16px';
            square.style.borderRadius = '3px';
            square.style.transition = 'var(--transition-fast)';
            square.style.flexShrink = '0';
            
            if (!isCurrentYear) {
                square.style.opacity = '0';
                square.style.pointerEvents = 'none';
            } else {
                // Month Label placement (first week of the month)
                if (currDate.getDate() <= 7 && currDate.getMonth() !== lastMonth) {
                    lastMonth = currDate.getMonth();
                    const monthSpan = document.createElement('span');
                    monthSpan.style.position = 'absolute';
                    monthSpan.style.left = `${col * 22 + 46}px`; // 22px is colWidth, 46px is padding for weekday labels
                    monthSpan.style.fontWeight = '600';
                    monthSpan.textContent = currDate.toLocaleDateString('en-US', { month: 'short' });
                    monthsEl.appendChild(monthSpan);
                }
                
                // Fetch tasks actually due on this day
                const dueTasks = filteredTasks.filter(t => {
                    const isDueToday = t.due_date === iso || (t.deadline && t.deadline.startsWith(iso));
                    const isOverdueCarry = iso === getTodayISO() && t.due_date < getTodayISO() && (state.settings && state.settings.carry_over_overdue !== false);
                    return isDueToday || isOverdueCarry;
                });
                const count = dueTasks.length;
                
                // Calculate workload weight ramping up urgency multiplied by importance
                let dayWeight = 0;
                const contributingTasks = [];
                
                filteredTasks.forEach(task => {
                    if (!task.due_date) return;
                    const diffDays = getDaysDiff(task.due_date, iso);
                    if (diffDays >= 0 && diffDays < 5) {
                        const priority = task.priority || 4;
                        const importance = 5 - priority; // p1 -> 4, p2 -> 3, p3 -> 2, p4 -> 1
                        const urgency = 1.0 - (diffDays * 0.2); // diffDays=0 -> 1.0, diffDays=4 -> 0.2
                        dayWeight += importance * urgency;
                        contributingTasks.push(task);
                    } else if (iso === getTodayISO() && task.due_date < getTodayISO() && (state.settings && state.settings.carry_over_overdue !== false)) {
                        const priority = task.priority || 4;
                        const importance = 5 - priority;
                        const urgency = 1.2; // higher urgency for overdue tasks to show bottleneck
                        dayWeight += importance * urgency;
                        contributingTasks.push(task);
                    }
                });
                
                // Flag bottlenecks (2 or more tasks due on same day)
                if (count >= 2) {
                    bottlenecks[iso] = dueTasks;
                }
                
                // Color level mapping based on dynamic workload weight
                let levelBg = 'rgba(255, 255, 255, 0.04)';
                let borderStyle = '1px solid var(--border-color)';
                let opacity = '1';
                
                if (dayWeight > 0) {
                    levelBg = 'var(--accent)';
                    borderStyle = 'none';
                    opacity = Math.min(1.0, 0.15 + (dayWeight / 8.0) * 0.85);
                }
                
                square.style.background = levelBg;
                if (borderStyle !== 'none') {
                    square.style.border = borderStyle;
                } else {
                    square.style.border = 'none';
                }
                square.style.opacity = opacity.toString();
                square.style.cursor = 'pointer';
                square.title = `${formatDateDMY(iso)}: Workload Index ${dayWeight.toFixed(1)}`;
                
                // Premium animations & Dynamic floating tooltip triggers
                square.onmouseenter = (e) => {
                    square.style.transform = 'scale(1.3)';
                    square.style.opacity = '1';
                    square.style.boxShadow = '0 0 8px var(--accent-glow, rgba(154, 75, 255, 0.4))';
                    square.style.zIndex = '10';
                    showFloatingTooltip(e, iso, dueTasks, dayWeight, contributingTasks);
                };
                square.onmouseleave = () => {
                    square.style.transform = 'scale(1)';
                    square.style.opacity = opacity.toString();
                    square.style.boxShadow = 'none';
                    square.style.zIndex = '1';
                    hideFloatingTooltip();
                };
            }
            
            colDiv.appendChild(square);
        }
        
        gridEl.appendChild(colDiv);
    }
    
    // Populate bottlenecks list
    const bottlenecksListEl = document.getElementById('workload-bottlenecks-list');
    bottlenecksListEl.innerHTML = '';
    
    const sortedDates = Object.keys(bottlenecks).sort((a, b) => a.localeCompare(b));
    
    if (sortedDates.length === 0) {
        bottlenecksListEl.innerHTML = `
            <div style="text-align:center; padding:24px; color:var(--text-muted); font-size:13px; font-style:italic;">
                <i class="fa-solid fa-circle-check" style="color:#2ECC71; font-size:24px; margin-bottom:8px; display:block;"></i>
                No workload bottlenecks detected! Your tasks are beautifully distributed.
            </div>
        `;
        return;
    }
    
    sortedDates.forEach(date => {
        const tasks = bottlenecks[date];
        const dateBlock = document.createElement('div');
        dateBlock.className = 'bottleneck-item-card';
        dateBlock.style.background = 'rgba(255, 255, 255, 0.02)';
        dateBlock.style.border = '1px solid var(--border-color)';
        dateBlock.style.borderRadius = 'var(--border-radius-md)';
        dateBlock.style.padding = '14px 18px';
        dateBlock.style.display = 'flex';
        dateBlock.style.flexDirection = 'column';
        dateBlock.style.gap = '10px';
        
        dateBlock.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                <span class="badge" style="background:rgba(255, 74, 74, 0.08); color:var(--prio-1); border:1px solid rgba(255, 74, 74, 0.2); font-weight:800; font-size:12px; padding:4px 10px; border-radius: 6px;">
                    <i class="fa-regular fa-calendar"></i> ${formatDateDMY(date)}
                </span>
                <span style="font-size:12px; color:var(--text-secondary); font-weight:600; background:rgba(154, 75, 255, 0.08); border:1px solid rgba(154, 75, 255, 0.15); padding:3px 10px; border-radius:12px;">
                    ${tasks.length} Overlapping Tasks
                </span>
            </div>
            <div style="display:flex; flex-direction:column; gap:8px;">
                ${tasks.map(t => {
                    const prioColor = t.priority === 1 ? 'var(--prio-1)' : 
                                     t.priority === 2 ? 'var(--prio-2)' : 
                                     t.priority === 3 ? 'var(--prio-3)' : 'var(--prio-4)';
                    const deadlineHtml = t.deadline ? `<span style="font-size:10px; color:#FF6B6B; background:rgba(255, 74, 74, 0.05); padding:2px 6px; border-radius:4px; border:1px solid rgba(255, 74, 74, 0.15);"><i class="fa-solid fa-hourglass-half"></i> ${formatDeadlineDMY(t.deadline)}</span>` : '';
                    return `
                        <div style="display:flex; align-items:center; gap:8px; justify-content:space-between; font-size:13px; color:var(--text-primary); padding: 6px 0; border-bottom:1px solid rgba(255,255,255,0.03);">
                            <div style="display:flex; align-items:center; gap:8px;">
                                <i class="fa-solid fa-flag" style="color:${prioColor}; font-size:12px;"></i>
                                <span>${t.title}</span>
                            </div>
                            <div style="display:flex; align-items:center; gap:8px;">
                                ${deadlineHtml}
                                <span class="task-tag project-tag" style="margin:0;"><i class="fa-solid fa-folder-open"></i> ${t.project}</span>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
        bottlenecksListEl.appendChild(dateBlock);
    });
}

function showFloatingTooltip(e, dateStr, tasks, workloadScore, contributingTasks) {
    let tooltip = document.getElementById('heatmap-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'heatmap-tooltip';
        tooltip.style.position = 'fixed';
        tooltip.style.background = 'var(--bg-card)';
        tooltip.style.border = '1px solid var(--border-color)';
        tooltip.style.borderRadius = 'var(--border-radius-md)';
        tooltip.style.padding = '12px 16px';
        tooltip.style.boxShadow = 'var(--shadow-premium)';
        tooltip.style.zIndex = '99999';
        tooltip.style.pointerEvents = 'none';
        tooltip.style.fontSize = '12px';
        tooltip.style.maxWidth = '280px';
        tooltip.style.fontFamily = 'var(--font-body)';
        tooltip.style.color = 'var(--text-primary)';
        tooltip.style.backdropFilter = 'var(--glass-blur)';
        document.body.appendChild(tooltip);
    }
    
    let dueTasksHtml = '';
    if (tasks.length === 0) {
        dueTasksHtml = '<div style="color:var(--text-muted); font-style:italic;">No tasks due</div>';
    } else {
        dueTasksHtml = tasks.map(t => {
            const prioIcon = t.priority === 1 ? '🔺' : t.priority === 2 ? '🔸' : t.priority === 3 ? '🔹' : '▫️';
            return `<div style="margin-top: 4px; display:flex; align-items:flex-start; gap:6px;">
                <span>${prioIcon}</span>
                <span>${t.title}</span>
            </div>`;
        }).join('');
    }

    let contributingHtml = '';
    if (contributingTasks && contributingTasks.length > 0) {
        const upcomingTasks = contributingTasks.filter(t => t.due_date !== dateStr);
        if (upcomingTasks.length > 0) {
            contributingHtml = `
                <div style="font-weight:600; color:var(--text-secondary); margin-top: 8px; margin-bottom: 4px; border-top: 1px solid var(--border-color); padding-top: 6px;">
                    Upcoming prep tasks:
                </div>
                <div style="max-height: 80px; overflow-y: auto; color: var(--text-muted); font-size: 11px;">
                    ${upcomingTasks.map(t => `<div>• ${t.title}</div>`).join('')}
                </div>
            `;
        }
    }
    
    tooltip.innerHTML = `
        <div style="font-weight:800; border-bottom:1px solid var(--border-color); padding-bottom:6px; margin-bottom:6px; color:var(--accent); font-family:var(--font-heading);">
            ${formatDateDMY(dateStr)}
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; font-weight:600;">
            <span style="color:var(--text-secondary);">Workload Index:</span>
            <span style="color:var(--accent); font-weight:700;">${workloadScore.toFixed(1)}</span>
        </div>
        <div style="font-weight:600; color:var(--text-secondary); margin-bottom: 4px;">
            Tasks due this day:
        </div>
        <div style="max-height: 120px; overflow-y: auto;">
            ${dueTasksHtml}
        </div>
        ${contributingHtml}
    `;
    
    tooltip.style.display = 'block';
    
    const tooltipWidth = tooltip.offsetWidth || 220;
    const tooltipHeight = tooltip.offsetHeight || 120;
    
    let posX = e.clientX + 12;
    let posY = e.clientY + 12;
    
    if (posX + tooltipWidth > window.innerWidth) {
        posX = e.clientX - tooltipWidth - 12;
    }
    if (posY + tooltipHeight > window.innerHeight) {
        posY = e.clientY - tooltipHeight - 12;
    }
    
    tooltip.style.left = posX + 'px';
    tooltip.style.top = posY + 'px';
}

function hideFloatingTooltip() {
    const tooltip = document.getElementById('heatmap-tooltip');
    if (tooltip) {
        tooltip.style.display = 'none';
    }
}


