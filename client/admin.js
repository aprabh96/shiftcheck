let token = null;

// When a signed-in session expires (or the account is removed), go back to the sign-in screen
// instead of leaving a half-working page.
const originalFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await originalFetch(...args);
  const url = String(args[0] || '');
  if (res.status === 401 && token && url.startsWith('/api/') && !url.startsWith('/api/auth/')) {
    alert('Your session has ended. Please sign in again.');
    window.location.reload();
  }
  return res;
};

// Show the business name from the server settings (BUSINESS_NAME).
originalFetch('/api/employees/config')
  .then((r) => (r.ok ? r.json() : null))
  .then((cfg) => {
    if (!cfg || !cfg.businessName) return;
    document.querySelectorAll('.business-name').forEach((el) => { el.textContent = cfg.businessName; });
    document.title = document.title.replace('ShiftCheck', cfg.businessName);
  })
  .catch(() => {});


// Escape text before it goes into innerHTML: names, titles, comments and signatures come from users.
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const employeesById = {};
const categoriesById = {};
let useCheckboxFilters = false; // Track current filter mode
let currentAdminTheme = 'light'; // Variable for admin theme
const empModal = new bootstrap.Modal(document.getElementById('empModal'));
const taskModal = new bootstrap.Modal(document.getElementById('taskModal'));
const bulkAssignModal = new bootstrap.Modal(document.getElementById('bulkAssignModal'));
let adminTaskDetailModal = null; // <-- Add this
let currentAdminModalTaskId = null; // <-- Add this
let currentAdminModalTask = null; // <-- Add this to hold task data
let selectedTaskIdsForBulkAssign = [];

// --- NEW: Function to apply theme (Admin) ---
function applyAdminTheme(theme) {
    if (theme === 'dark') {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
    }
    currentAdminTheme = theme;
    // Update admin toggle button text/icon if it exists
    const toggleBtn = document.getElementById('adminThemeToggleBtn');
    if (toggleBtn) {
        toggleBtn.textContent = theme === 'dark' ? '☀️ Light' : '🌙 Dark';
    }
    // HACK: Charts might need redraw on theme change for colors
    // Consider calling chart render functions if colors don't update
    // e.g., if (window.statsChartInstance) loadStats();
}

// --- NEW: Function to toggle theme (Admin) ---
async function toggleAdminTheme() {
    const newTheme = currentAdminTheme === 'light' ? 'dark' : 'light';
    try {
        const res = await fetch('/api/user/theme', { // Uses the same endpoint
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ theme: newTheme })
        });
        if (!res.ok) {
            throw new Error('Failed to update theme preference');
        }
        applyAdminTheme(newTheme);
    } catch (error) {
        console.error('Admin theme toggle error:', error);
        showToast('Could not save theme preference.'); // Use admin toast
    }
}

function debounce(fn, ms = 300){
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(()=> fn(...args), ms);
  };
}

// ---------- login ----------
async function adminLogin() {
  const pin = document.getElementById('adminPin').value.trim();
  if (!pin) return;

  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin })
  });
  if (!res.ok) return showToast('Bad PIN');

  const data = await res.json();
  token = data.token;

  // --- APPLY ADMIN THEME ---
  applyAdminTheme(data.theme || 'light'); // Use fetched theme

  document.getElementById('loginPane').classList.add('d-none');
  document.getElementById('adminPane').classList.remove('d-none');

  // --- ADD ADMIN THEME TOGGLE BUTTON ---
  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'adminThemeToggleBtn';
  toggleBtn.className = 'btn btn-sm btn-outline-secondary';
  toggleBtn.onclick = toggleAdminTheme;
  // Set initial text based on applied theme
  toggleBtn.textContent = currentAdminTheme === 'dark' ? '☀️ Light' : '🌙 Dark';
  document.body.appendChild(toggleBtn); // Add button to the body

  // Load data AFTER applying theme and showing pane
  await loadEmployees();
  await loadCategories();
  await loadCategoriesList();
  await loadTasks();
  await loadLogs();
  await loadCheckouts();
  await loadStats();

  // --- Setup tab listeners ---
  setupTabListeners();

  // --- Initialize Admin Task Detail Modal ---
  const modalElement = document.getElementById('adminTaskDetailModal');
  if (modalElement) {
       adminTaskDetailModal = new bootstrap.Modal(modalElement);
  }
}

// ---------- employees ----------
async function loadEmployees() {
  const res = await fetch('/api/admin/employees', { headers: { Authorization: `Bearer ${token}` } });
  const list = await res.json();
  let html = '';
  for (const e of list) {
    employeesById[e.id] = e;
    html += `<tr>
      <td>${e.id}</td>
      <td>${esc(e.name)}${e.is_locked ? ' <span class="badge bg-danger ms-1">Locked</span>' : ''}</td>
      <td>${esc(e.role)}</td>
      <td class="text-end">
        <button class="btn btn-sm btn-outline-warning me-1" onclick="unlockEmp(${e.id})" title="Unlock Account" ${!e.is_locked ? 'style="display:none;"' : ''}>🔓</button>
        <button class="btn btn-sm btn-outline-primary me-1" onclick="editEmp(employeesById[${e.id}])" title="Edit Employee">✏️</button>
        <button class="btn btn-sm btn-outline-danger" onclick="delEmp(${e.id})" title="Delete Employee">🗑️</button>
      </td>
    </tr>`;
  }
  document.getElementById('empRows').innerHTML = html;
}

async function loadCategoriesForEmployeeModal(empId) {
  // Fetch all categories
  const catsRes = await fetch('/api/admin/categories', { headers: { Authorization: `Bearer ${token}` } });
  const cats = await catsRes.json();
  // Fetch assigned categories for this employee (if editing)
  let assigned = [];
  if (empId) {
    const assignedRes = await fetch(`/api/admin/employees/${empId}/categories`, { headers: { Authorization: `Bearer ${token}` } });
    assigned = await assignedRes.json();
  }
  // Render checkboxes
  const listDiv = document.getElementById('empCategoryList');
  listDiv.innerHTML = '';
  if (cats.length === 0) {
    listDiv.innerHTML = '<span class="text-muted small">No categories found.</span>';
    return;
  }
  cats.forEach(cat => {
    const div = document.createElement('div');
    div.className = 'form-check';
    div.innerHTML = `
      <input class="form-check-input" type="checkbox" value="${cat.id}" id="empCatCheck-${cat.id}" ${assigned.includes(cat.id) ? 'checked' : ''}>
      <label class="form-check-label" for="empCatCheck-${cat.id}">${esc(cat.name)}</label>
    `;
    listDiv.appendChild(div);
  });
}

function showEmpModal() {
  document.getElementById('empId').value = '';
  document.getElementById('empName').value = '';
  document.getElementById('empPinNew').value = '';
  document.getElementById('empRole').value = 'employee';
  loadCategoriesForEmployeeModal(null);
  empModal.show();
}
function editEmp(e) {
  document.getElementById('empId').value = e.id;
  document.getElementById('empName').value = e.name;
  document.getElementById('empPinNew').value = '';
  document.getElementById('empRole').value = e.role;
  loadCategoriesForEmployeeModal(e.id);
  empModal.show();
}
async function saveEmp() {
  const id = document.getElementById('empId').value;
  const body = {
    name: document.getElementById('empName').value.trim(),
    pin: document.getElementById('empPinNew').value.trim(),
    role: document.getElementById('empRole').value
  };
  let res;
  if (id) {
    res = await fetch(`/api/admin/employees/${id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } else {
    res = await fetch('/api/admin/employees', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  }
  if (!res.ok) {
    let msg = 'Could not save the employee.';
    try { msg = (await res.json()).msg || msg; } catch { /* keep the default */ }
    showToast(msg);
    return;
  }
  // Save category assignments
  const empId = id || (await res.json()).id;
  const selectedCatIds = Array.from(document.querySelectorAll('#empCategoryList input:checked')).map(cb => parseInt(cb.value, 10));
  await fetch(`/api/admin/employees/${empId}/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ categoryIds: selectedCatIds })
  });
  await loadEmployees();
  await loadTasks();
  empModal.hide();
}
async function delEmp(id) {
  if (!confirm('Delete employee?')) return;
  await fetch(`/api/admin/employees/${id}`, {
    method:'DELETE', headers:{Authorization:`Bearer ${token}`}
  });
  await loadEmployees();
}

async function unlockEmp(id) {
  if (!confirm('Unlock this employee account?')) return;
  try {
    const res = await fetch(`/api/admin/employees/${id}/unlock`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.msg || `Failed to unlock (${res.status})`);
    }
    showToast(data.msg || 'Account unlocked.');
    await loadEmployees(); // Refresh the employee list to show unlocked status
  } catch (error) {
    console.error("Unlock error:", error);
    showToast(`Error: ${error.message}`);
  }
}

// ---------- categories ----------
async function loadCategories() {
  const res = await fetch('/api/admin/categories', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const cats = await res.json();
  // Populate "Add/Edit Task" modal
  const taskSel = document.getElementById('modalTaskCategory');
  taskSel.innerHTML = cats.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
}

// ---------- category management tab ----------
const catModal = new bootstrap.Modal(document.getElementById('catModal'));

async function loadCategoriesList() {
  const res = await fetch('/api/admin/categories', { headers:{Authorization:`Bearer ${token}`} });
  const cats = await res.json();
  const tbody = document.getElementById('catRows');
  tbody.innerHTML = '';
  cats.forEach(c=> {
    categoriesById[c.id] = c;
    const tr = document.createElement('tr');
    tr.setAttribute('data-id', c.id); // Add data-id attribute for drag-and-drop
    tr.innerHTML = `
      <td>${c.id}</td>
      <td>${esc(c.name)}</td>
      <td class="text-end">
        <button class="btn btn-sm btn-outline-primary" onclick="editCat(${c.id}, categoriesById[${c.id}].name)">✏️</button>
        <button class="btn btn-sm btn-outline-danger" onclick="delCat(${c.id})">🗑️</button>
      </td>`;
    tbody.appendChild(tr);
  });

  // Initialize SortableJS for categories
  new Sortable(tbody, {
    animation: 150,
    onEnd: async function(evt) {
      const orderedIds = Array.from(evt.to.children)
                                .map(tr => parseInt(tr.getAttribute('data-id'), 10));

      try {
        const res = await fetch('/api/admin/categories/reorder', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ orderedIds })
        });

        if (!res.ok) {
          // try to grab any JSON error message
          let errMsg = `${res.status} ${res.statusText}`;
          try {
            const payload = await res.json();
            if (payload.msg) errMsg = payload.msg;
          } catch (_) {}
          console.error('Category reorder failed:', errMsg);
          showToast(`Could not reorder categories: ${errMsg}`);
          return;
        }

        // success → reload to reflect new order
        await loadCategoriesList();

      } catch (networkErr) {
        console.error('Network error during category reorder:', networkErr);
        showToast(`Network error: ${networkErr.message}`);
      }
    }
  });
}

function showCatModal() {
  document.getElementById('catId').value = '';
  document.getElementById('catName').value = '';
  catModal.show();
}

function editCat(id,name) {
  document.getElementById('catId').value = id;
  document.getElementById('catName').value = name;
  catModal.show();
}

async function saveCat() {
  const id = document.getElementById('catId').value;
  const name = document.getElementById('catName').value.trim();
  const url = id ? `/api/admin/categories/${id}` : '/api/admin/categories';
  const method = id ? 'PUT' : 'POST';
  await fetch(url, {
    method, headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`},
    body: JSON.stringify({ name })
  });
  catModal.hide();
  await loadCategoriesList();
  await loadCategories();      // refresh dropdowns for tasks
  if (typeof populateCategoryFilter === 'function') await populateCategoryFilter(); // if you have a filter list
}

async function delCat(id) {
  if (!confirm('Delete category?')) return;
  await fetch(`/api/admin/categories/${id}`, {
    method:'DELETE', headers:{Authorization:`Bearer ${token}`}
  });
  await loadCategoriesList();
  await loadCategories();
}

// ---------- tasks ----------
async function loadTasks() {
  try {
    // 1. Fetch ALL categories first
    const categoriesRes = await fetch('/api/admin/categories', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!categoriesRes.ok) {
      throw new Error('Failed to fetch categories');
    }
    const categories = await categoriesRes.json();

    // 2. Fetch tasks
    const tasksRes = await fetch('/api/admin/tasks', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!tasksRes.ok) {
      throw new Error('Failed to fetch tasks');
    }
    const tasks = await tasksRes.json();

    // 3. Group tasks by category ID
    const tasksByCategoryId = {};
    tasks.forEach(t => {
      if (!tasksByCategoryId[t.categoryId]) {
        tasksByCategoryId[t.categoryId] = [];
      }
      tasksByCategoryId[t.categoryId].push(t);
    });

    // 4. Build accordion from all categories
    const accordion = document.getElementById('adminTasksAccordion');
    accordion.innerHTML = '';

    // Sort categories by sort_order (they should already be sorted from the API)
    categories.forEach(category => {
      const addAccordionCategory = (categoryId, categoryName, tasks) => {
        const accordionId = `adminTaskCat-${categoryId}`; // Base ID for elements
        const collapseTargetId = `collapse-${accordionId}`;
        const headingId = `heading-${accordionId}`;
        const tbodyId = `tbody-${accordionId}`;
        const checkAllId = `check-all-${accordionId}`; // Unique ID for check-all

        const categoryTitle = categoryName || 'Uncategorized';

        // Calculate overdue count for the badge
        const overdueCount = tasks.filter(t => t.overdue).length;
        const unreadCount = tasks.filter(t => t.hasUnreadComments).length;
        // Calculate badge HTML parts separately
        let taskBadgeHtml = `<span class="badge ms-2 ${overdueCount > 0 ? 'bg-danger' : 'bg-secondary'}">${tasks.length} Task${tasks.length !== 1 ? 's' : ''}${overdueCount > 0 ? ` / ${overdueCount} Overdue` : ''}</span>`;
        let commentBadgeHtml = '';
        if (unreadCount > 0) {
            commentBadgeHtml = `<span class="badge ms-1 bg-info">${unreadCount} New Comment${unreadCount !== 1 ? 's' : ''}</span>`;
        }
        const badgeHtml = taskBadgeHtml + commentBadgeHtml; // Combine them

        const div = document.createElement('div');
        div.className = 'accordion-item';
        div.innerHTML = `
          <h2 class="accordion-header" id="${headingId}">
            <button class="accordion-button collapsed d-flex justify-content-between align-items-center" type="button" data-bs-toggle="collapse" data-bs-target="#${collapseTargetId}" aria-expanded="false" aria-controls="${collapseTargetId}">
              <span>${esc(categoryTitle)}</span>
              <div class="ms-auto d-flex align-items-center">
                ${badgeHtml}
                <button class="btn btn-sm btn-success ms-3 py-0 px-1" onclick="event.stopPropagation(); showTaskModal(${categoryId})" title="Add Task to ${esc(categoryTitle)}">+</button>
              </div>
            </button>
          </h2>
          <div id="${collapseTargetId}" class="accordion-collapse collapse" aria-labelledby="${headingId}" data-bs-parent="#adminTasksAccordion">
            <div class="accordion-body p-0">
              <div class="table-responsive">
                <table class="table table-sm table-bordered mb-0">
                  <thead class="table-light">
                    <tr>
                      <th style="width:30px"><input type="checkbox" id="${checkAllId}" class="form-check-input category-check-all" data-target-tbody="${tbodyId}" title="Select all in ${esc(categoryTitle)}"></th>
                      <th>ID</th>
                      <th>Title</th>
                      <th>Tolerance</th>
                      <th>Assigned To</th>
                      <th>Last Done</th>
                      <th>Last By</th>
                      <th class="text-end">Actions</th>
                    </tr>
                  </thead>
                  <tbody id="${tbodyId}"></tbody>
                </table>
              </div>
            </div>
          </div>
        `;
        accordion.appendChild(div);

        // Sort tasks by sort_order
        const sortedTasks = tasks.sort((a, b) => a.sort_order - b.sort_order);

        const tbody = document.getElementById(`${tbodyId}`);
        tbody.innerHTML = '';
        tbody.dataset.categoryId = categoryId; // Store category ID for drag-and-drop

        if (sortedTasks.length === 0) {
          const tr = document.createElement('tr');
          tr.innerHTML = '<td colspan="8" class="text-center text-muted">No tasks in this category</td>';
          tbody.appendChild(tr);
        } else {
          sortedTasks.forEach(t => {
            const tr = document.createElement('tr');
            tr.setAttribute('data-task-id', t.id);
            tr.id = `admin-task-row-${t.id}`;
            tr.dataset.taskData = JSON.stringify(t);
            if (t.overdue) tr.classList.add('table-danger');
            if (t.hasUnreadComments) tr.classList.add('task-unread-comments');

            // 1. Checkbox Cell
            const cellCheckbox = tr.insertCell();
            cellCheckbox.style.width = '30px';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'form-check-input task-checkbox';
            checkbox.value = t.id;
            checkbox.dataset.taskId = t.id;
            checkbox.checked = selectedTaskIdsForBulkAssign.includes(t.id);
            cellCheckbox.appendChild(checkbox);

            // 2. ID Cell
            const cellId = tr.insertCell();
            cellId.textContent = t.id;

            // 3. Title Cell (with optional badge)
            const cellTitle = tr.insertCell();
            cellTitle.className = 'task-title-clickable';
            cellTitle.textContent = t.title;
            if (t.hasUnreadComments) {
                cellTitle.insertAdjacentHTML('beforeend', ' ');
                const badge = document.createElement('span');
                badge.className = 'badge rounded-pill bg-info unread-badge';
                badge.textContent = 'New Comment';
                cellTitle.appendChild(badge);
            }

            // 4. Tolerance Cell
            const cellTolerance = tr.insertCell();
            if (t.no_timeout) {
                cellTolerance.innerHTML = '<em class="text-muted">N/A</em>';
            } else {
                cellTolerance.textContent = t.tolerance_hours;
            }

            // 5. Assigned To Cell
            const cellAssigned = tr.insertCell();
            if (t.Employees && t.Employees.length > 0) {
                cellAssigned.textContent = t.Employees.map(e => e.name).join(', ');
            } else {
                cellAssigned.innerHTML = '<em class="text-muted">None</em>';
            }

            // 6. Last Done Cell
            const cellLastDone = tr.insertCell();
            const smallLastDone = document.createElement('small');
            smallLastDone.textContent = t.last_done || 'Never';
            cellLastDone.appendChild(smallLastDone);

            // 7. Last By Cell
            const cellLastBy = tr.insertCell();
            const smallLastBy = document.createElement('small');
            smallLastBy.textContent = t.lastBy || '-';
            cellLastBy.appendChild(smallLastBy);

            // 8. Actions Cell
            const cellActions = tr.insertCell();
            cellActions.className = 'text-end text-nowrap';
            cellActions.innerHTML = `
                <button class="btn btn-sm btn-outline-primary me-1 py-0 px-1" onclick="editTaskHandler(${t.id})" title="Edit Task">✏️</button>
                <button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="delTask(${t.id})" title="Delete Task">🗑️</button>
            `;

            tbody.appendChild(tr);
          });
        }

        // Add change listener for the individual task checkboxes
        tbody.addEventListener('change', handleTaskCheckboxChange);

        // Initialize SortableJS for tasks within this category
        new Sortable(tbody, {
          animation: 150,
          onEnd: async function(evt) {
            const currentCategoryId = parseInt(evt.to.dataset.categoryId, 10);
            if (isNaN(currentCategoryId)) {
              console.error("Could not determine category ID for task reorder");
              return;
            }

            const orderedIds = Array.from(evt.to.children)
              .filter(tr => tr.getAttribute('data-task-id')) // Filter out the "no tasks" row
              .map(tr => parseInt(tr.getAttribute('data-task-id'), 10));

            if (orderedIds.length === 0) return; // No tasks to reorder

            try {
              const res = await fetch(`/api/admin/categories/${currentCategoryId}/tasks/reorder`, {
                method: 'PUT',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ orderedIds })
              });
              if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.msg || 'Failed to reorder tasks');
              }
              showToast('Tasks reordered successfully.');
              await loadTasks(); // Reload to ensure order is correct
            } catch (error) {
              console.error('Error reordering tasks:', error);
              showToast(`Error: ${error.message}`);
              await loadTasks(); // Reload to show server state on error
            }
          }
        });
      };

      // Pass the tasks for this category (or empty array if none)
      addAccordionCategory(category.id, category.name, tasksByCategoryId[category.id] || []);
    });

    // Update bulk assign button state
    updateBulkAssignButtonState();
  } catch (error) {
    console.error('Error loading tasks:', error);
    showToast(`Error: ${error.message}`);
  }
}

// New helper function to handle the edit button click safely
function editTaskHandler(taskId) {
  const row = document.getElementById(`admin-task-row-${taskId}`);
  if (!row || !row.dataset.taskData) {
    console.error(`Could not find task data attribute for task ID ${taskId}`);
    showToast('Error retrieving task data.');
    return;
  }
  try {
    // Parse the data stored in the data-* attribute
    const taskData = JSON.parse(row.dataset.taskData);
    // Call the original editTask function with the parsed object
    editTask(taskData);
  } catch (e) {
    console.error(`Failed to parse task data for ID ${taskId}:`, e);
    showToast('Error parsing task data.');
  }
}

// Modify the function signature to accept categoryId
function showTaskModal(categoryId = null) {
    const categoryDropdown = document.getElementById('modalTaskCategory');
    const taskIdInput = document.getElementById('taskId');
    const tolInput = document.getElementById('taskTol');

    // Reset form fields
    taskIdInput.value = '';
    document.getElementById('taskTitle').value = '';
    document.getElementById('taskDesc').value = '';
    categoryDropdown.selectedIndex = 0;
    tolInput.value = 24;
    document.getElementById('taskNoTimeout').checked = false;

    // Handle category pre-selection
    if (categoryId !== null && categoryId > 0) {
        categoryDropdown.value = categoryId;
        categoryDropdown.disabled = true;
        suggestTolerance();
        toggleToleranceInput();
    } else {
        categoryDropdown.disabled = false;
        suggestTolerance();
        toggleToleranceInput();
    }

    // Load employees for assignment (no task ID means new task, no pre-checked boxes)
    loadAssignmentsForTaskModal(null);

    taskModal.show();
}

function editTask(t) {
    document.getElementById('taskId').value = t.id;
    document.getElementById('taskTitle').value = t.title;
    document.getElementById('taskDesc').value = t.description || '';
    const categoryDropdown = document.getElementById('modalTaskCategory');
    categoryDropdown.value = t.categoryId || '';
    categoryDropdown.disabled = false;
    document.getElementById('taskTol').value = t.tolerance_hours || 24;
    document.getElementById('taskNoTimeout').checked = t.no_timeout || false;
    
    // Load employees and check the currently assigned ones for this task
    loadAssignmentsForTaskModal(t.id);
    
    toggleToleranceInput();
    taskModal.show();
}

async function saveTask() {
    const id = document.getElementById('taskId').value;
    const categoryDropdown = document.getElementById('modalTaskCategory');
    const selectedCategoryId = parseInt(categoryDropdown.value, 10);
    const selectedCategoryName = categoryDropdown.options[categoryDropdown.selectedIndex]?.text || `ID ${selectedCategoryId}`;
    const body = {
        title: document.getElementById('taskTitle').value.trim(),
        description: document.getElementById('taskDesc').value.trim(),
        tolerance_hours: parseInt(document.getElementById('taskTol').value, 10) || 0,
        no_timeout: document.getElementById('taskNoTimeout').checked,
        category_id: selectedCategoryId
    };

    // --- Input Validation ---
    if (!body.title) {
         showToast('Task title cannot be empty.');
         return;
    }
     if (!body.category_id) {
         showToast('Please select a task category.');
         return;
     }
    if (body.no_timeout) {
        body.tolerance_hours = 0;
    } else if (isNaN(body.tolerance_hours) || body.tolerance_hours < 0) {
        showToast('Tolerance hours must be a non-negative number.');
        return;
    }
    // --- End Validation ---

    // Get selected employees
    const selectedEmployeeIds = Array.from(
        document.querySelectorAll('#editTaskEmployeeList input:checked')
    ).map(input => parseInt(input.value, 10));

    // Disable save button during processing
    const saveButton = document.querySelector('#taskModal .btn-primary');
    saveButton.disabled = true;
    saveButton.textContent = 'Saving...';

    let savedTaskId = id ? parseInt(id, 10) : null;
    let taskApiError = null;

    // --- Step 1: Save Task Details (Create or Update) ---
    const url = id ? `/api/admin/tasks/${id}` : '/api/admin/tasks';
    const method = id ? 'PUT' : 'POST';

    try {
        const res = await fetch(url, {
            method: method,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const errorData = await res.json().catch(() => ({ msg: `Failed to save task details (${res.status})` }));
            throw new Error(errorData.msg || `HTTP error ${res.status}`);
        }

        if (!savedTaskId) { // If it was a new task, get the ID
            const newTaskData = await res.json();
            savedTaskId = newTaskData.id;
            if (!savedTaskId) {
                throw new Error("Failed to get ID for newly created task.");
            }
        }

    } catch (error) {
        console.error(`Error saving task details (ID: ${id || 'new'}):`, error);
        showToast(`Error saving task: ${error.message}`);
        taskApiError = error; // Store error to prevent assignment step
    }

    // --- Step 2: Check Employee Access & Handle Assignments (only if task save succeeded) ---
    if (!taskApiError && savedTaskId) {
        try {
            // -- Check Access --
            const checkRes = await fetch(`/api/admin/categories/${selectedCategoryId}/check-employee-access?employeeIds=${selectedEmployeeIds.join(',')}`, {
                 headers: { Authorization: `Bearer ${token}` }
            });

            if (!checkRes.ok) {
                const errorData = await checkRes.json().catch(() => ({ msg: `Failed to check access (${checkRes.status})` }));
                throw new Error(errorData.msg || 'Failed to check employee access');
            }

            const { employeesWithoutAccess } = await checkRes.json();

            if (employeesWithoutAccess && employeesWithoutAccess.length > 0) {
                // -- Prompt Admin --
                const employeeNames = employeesWithoutAccess.map(e => e.name).join(', ');
                const confirmationMessage = `The following employees do not have access to the category \"${selectedCategoryName}\":\n\n${employeeNames}\n\nGrant access to these employees and save the task assignment?`;

                if (confirm(confirmationMessage)) {
                    // -- Grant Access and Assign --
                    const grantAssignRes = await fetch(`/api/admin/tasks/${savedTaskId}/assign-and-grant-category`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${token}`
                        },
                        body: JSON.stringify({ employeeIds: selectedEmployeeIds, categoryId: selectedCategoryId })
                    });

                    if (!grantAssignRes.ok) {
                        const errorData = await grantAssignRes.json().catch(() => ({ msg: `Failed grant/assign (${grantAssignRes.status})` }));
                        throw new Error(errorData.msg || 'Failed to grant access and assign task');
                    }
                    showToast('Category access granted and task assigned!');

                } else {
                    // -- Admin Cancelled --
                    saveButton.disabled = false;
                    saveButton.textContent = 'Save';
                    return;
                }

            } else {
                // -- All employees have access, proceed with normal assignment --
                const assignRes = await fetch(`/api/admin/tasks/${savedTaskId}/set-assignments`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`
                    },
                    body: JSON.stringify({ employeeIds: selectedEmployeeIds })
                });

                if (!assignRes.ok) {
                    const assignErrorData = await assignRes.json().catch(() => ({ msg: `Failed assignment (${assignRes.status})` }));
                    console.error("Task saved, but failed to update assignments:", assignErrorData.msg);
                    showToast(`Task details saved, but assignment update failed: ${assignErrorData.msg}`);
                } else {
                     showToast(id ? 'Task and assignments updated!' : 'Task added and assigned!');
                }
            }

            // --- Success Case (Normal Assignment or Grant/Assign) ---
            categoryDropdown.disabled = false;
            taskModal.hide();
            await loadTasks();

        } catch (error) {
            // --- Error during Access Check or Assignment/Granting ---
            console.error(`Error during assignment phase for task ${savedTaskId}:`, error);
            showToast(`Error updating assignments: ${error.message}`);
            saveButton.disabled = false;
            saveButton.textContent = 'Save';
            return;
        }

    }

    // --- Final step: Re-enable button if it hasn't been handled by cancellation/error already ---
    if (saveButton.disabled) {
        saveButton.disabled = false;
        saveButton.textContent = 'Save';
    }
    if (categoryDropdown.disabled) {
         categoryDropdown.disabled = false;
    }
}

// New function to load employees and current assignments for task modal
async function loadAssignmentsForTaskModal(taskId) {
    const listDiv = document.getElementById('editTaskEmployeeList');
    listDiv.innerHTML = '<div class="text-center p-3 text-muted small">Loading...</div>'; // Show loading state

    try {
        // Fetch all employees
        const empRes = await fetch('/api/admin/employees', {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!empRes.ok) throw new Error('Failed to load employees');
        const employees = await empRes.json();

        // Fetch current assignments for this task (only if taskId is provided, i.e., editing)
        let assignedEmployeeIds = [];
        if (taskId) {
            const assignRes = await fetch(`/api/admin/tasks/${taskId}/assignments`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!assignRes.ok) throw new Error('Failed to load assignments');
            assignedEmployeeIds = await assignRes.json();
        }

        // Populate the modal list
        listDiv.innerHTML = ''; // Clear loading/previous content
        if (employees.length === 0) {
            listDiv.innerHTML = '<div class="text-center p-3 text-muted small">No employees found.</div>';
            return;
        }

        employees.forEach(emp => {
            const isChecked = assignedEmployeeIds.includes(emp.id);
            const div = document.createElement('div');
            div.className = 'form-check';
            // Use unique IDs for labels/inputs inside this modal
            div.innerHTML = `
                <input class="form-check-input" type="checkbox" value="${emp.id}" id="editTaskEmpCheck-${emp.id}" ${isChecked ? 'checked' : ''}>
                <label class="form-check-label" for="editTaskEmpCheck-${emp.id}">
                    ${esc(emp.name)} <span class="text-muted small">(${esc(emp.role)})</span>
                </label>
            `;
            listDiv.appendChild(div);
        });

    } catch (error) {
        console.error("Error loading assignment data for task modal:", error);
        listDiv.innerHTML = '<div class="alert alert-danger p-2 small">Could not load employee data.</div>';
        showToast('Error loading employee assignments.');
    }
}

async function delTask(id) {
    const res = await fetch(`/api/admin/tasks/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
    });
    // Remove from selection if it was selected
    const index = selectedTaskIdsForBulkAssign.indexOf(id);
    if (index > -1) {
        selectedTaskIdsForBulkAssign.splice(index, 1);
    }
    await loadTasks(); // Reload tasks, which will also update button state implicitly
}

// ---------- logs ----------
async function loadLogs(page=1) {
  const search = document.getElementById('logSearch').value.trim();
  const res = await fetch(`/api/admin/logs?page=${page}&search=${encodeURIComponent(search)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return showToast('Could not load logs');
  const { total, pages, logs } = await res.json();
  const tbody = document.getElementById('logRows');
  tbody.innerHTML = '';
  logs.forEach(l => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${l.id}</td>
      <td>${esc(l.Task?.title)}</td>
      <td>${esc(l.Employee?.name)}</td>
      <td>${esc(l.display_name || l.Employee?.name)}</td>
      <td>${esc(new Date(l.completed_at).toLocaleString())}</td>
      <td>${esc(l.ip)}</td>
      <td>${esc(l.location)}</td>
    `;
    tbody.appendChild(tr);
  });
  const pager = document.getElementById('logPager');
  pager.innerHTML = '';
  for(let p=1; p<=pages; p++){
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm ' + (p===page?'btn-primary':'btn-outline-primary');
    btn.textContent = p;
    btn.onclick = ()=> loadLogs(p);
    pager.append(btn);
  }
}

async function loadCheckouts() {
  const res = await fetch('/api/admin/checkouts', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const list = await res.json();
  const tbody = document.getElementById('checkoutRows');
  tbody.innerHTML = '';
  list.forEach(c => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${c.id}</td>
      <td>${esc(c.Employee?.name)}</td>
      <td>${esc(c.checklist_json?.displayName || 'Signer N/A')}</td>
      <td>${esc(new Date(c.checkout_at).toLocaleString())}</td>
      <td>${esc(c.ip)}</td>
      <td>${esc(c.location)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// On page load, trigger stats load so charts appear immediately
window.addEventListener('DOMContentLoaded', () => {
  // stats will only load after login, so no auto-load here
  document.getElementById('logSearch')
    .addEventListener('input', debounce(() => loadLogs(1), 400));
});

async function loadStats() {
  const refreshBtn = document.querySelector('#statsTab button.btn-primary');
  const spinner = document.getElementById('statsSpinner');
  if (refreshBtn) refreshBtn.disabled = true;
  if (spinner) spinner.style.display = '';
  try {
    const start = document.getElementById('statsStart').value;
    const end   = document.getElementById('statsEnd').value;
    const res   = await fetch(`/api/admin/stats/completions?start=${start}&end=${end}`, {
      headers:{ Authorization:`Bearer ${token}` }
    });
    const data  = await res.json();
    renderPieChart(data);
    // fetch overdue stats
    const overRes = await fetch(`/api/admin/stats/overdue?start=${start}&end=${end}`,{
      headers:{Authorization:`Bearer ${token}`}
    });
    if (!overRes.ok) {
      const msg = await overRes.text();
      throw new Error(`Overdue-stats API ${overRes.status}: ${msg}`);
    }
    const overdueData = await overRes.json();
    const ctx2 = document.getElementById('overdueChart').getContext('2d');
    if (window.overdueChartInstance) window.overdueChartInstance.destroy();
    window.overdueChartInstance = new Chart(ctx2, {
      type:'bar',
      data: {
        labels: overdueData.map(r=>r.name),
        datasets:[{ data: overdueData.map(r=>r.count) }]
      },
      options:{ indexAxis:'y' }
    });
    // Recent 10 checkouts
    const feedRes = await fetch('/api/admin/checkouts?limit=10', {
      headers:{Authorization:`Bearer ${token}`}
    });
    const recents = await feedRes.json();
    const feed = document.getElementById('recentFeed');
    feed.innerHTML = '';
    recents.slice(0,10).forEach(c => {
      const li = document.createElement('li');
      li.className = 'list-group-item';
      li.textContent = `${c.Employee.name} signed by ${c.checklist_json.displayName} at ${new Date(c.checkout_at).toLocaleString()}`;
      feed.append(li);
    });
    // At the end, render calendar and bar chart
    await renderCalendar(start, end);
    await renderBarChart(start, end);
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
    if (spinner) spinner.style.display = 'none';
  }
}

function renderPieChart(rows) {
  const ctx = document.getElementById('statsChart').getContext('2d');
  if (window.statsChartInstance) window.statsChartInstance.destroy();
  window.statsChartInstance = new Chart(ctx, {
    type: 'pie',
    data: {
      labels: rows.map(r => r.Employee.name),
      datasets: [{
        data:  rows.map(r => r.count),
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
        },
        title: {
          display: true,
          text: 'Completions by Employee'
        }
      },
      onClick(e, els) {
        if (!els.length) return;
        const idx = els[0].index;
        const name = rows[idx].Employee.name;
        document.getElementById('logSearch').value = name;
        // jump to Logs tab
        bootstrap.Tab.getOrCreateInstance(
          document.querySelector('[data-bs-target="#logTab"]')
        ).show();
        loadLogs(1);
      }
    }
  });
}

async function renderCalendar(start, end) {
  const container = document.getElementById('calendarContainer');
  container.innerHTML = ''; // Clear previous content first

  // Destroy previous chart instance if it exists
  if (window.calendarChartInstance) {
    window.calendarChartInstance.destroy();
    window.calendarChartInstance = null;
  }

  try {
    const daily = await fetch(`/api/admin/stats/daily?start=${start}&end=${end}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());

    if (!daily || daily.length === 0) {
      container.innerHTML = '<p class="text-center text-muted">No completion data for this period.</p>';
      return; // Exit if no data
    }

    const days = daily.map(d => ({ x: new Date(d.day), y: 0, v: d.count }));
    const maxValue = Math.max(...days.map(x => x.v)); // Get max value for color scaling

    const ctx = document.createElement('canvas');
    ctx.height = 40;
    container.appendChild(ctx);

    window.calendarChartInstance = new Chart(ctx, {
      type: 'matrix',
      data: {
        datasets: [{
          label: 'Completions',
          data: days,
          width: 20,
          height: 20,
          // Ensure division by zero doesn't happen if maxValue is 0
          backgroundColor: ctx => {
            const v = ctx.raw.v;
            const alpha = 0.2 + 0.8 * (v / (maxValue || 1));
            return `rgba(0,123,255,${alpha})`;
          }
        }]
      },
      options: {
        scales: {
          x: { type: 'time', time: { unit: 'day' } },
          y: { display: false }
        },
        plugins: {
          tooltip: { enabled: false },
          legend: { display: false }
        }
      }
    });
  } catch (error) {
    console.error("Error rendering calendar chart:", error);
    container.innerHTML = '<p class="text-center text-danger">Error loading calendar data.</p>';
    showToast('Failed to render completions calendar.');
  }
}

async function renderBarChart(start, end) {
  const container = document.getElementById('barChartContainer');
  container.innerHTML = ''; // Clear previous content

  // Destroy previous chart instance if it exists
  if (window.barChartInstance) {
    window.barChartInstance.destroy();
    window.barChartInstance = null;
  }

  try {
      const daily = await fetch(`/api/admin/stats/daily?start=${start}&end=${end}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());

      if (!daily || daily.length === 0) {
          container.innerHTML = '<p class="text-center text-muted">No daily completion data for this period.</p>';
          return; // Exit if no data
      }

      const labels = daily.map(d => d.day); // Keep as string dates for labels
      const data = daily.map(d => d.count);

      const ctx = document.createElement('canvas');
      ctx.height = 60;
      container.appendChild(ctx);

      window.barChartInstance = new Chart(ctx, {
          type: 'bar',
          data: { labels, datasets: [{ data }] },
          options: {
              plugins: { legend: { display: false } },
              scales: {
                  x: { type: 'category', labels: labels },
                  y: { beginAtZero: true }
              }
          }
      });
  } catch (error) {
    console.error("Error rendering bar chart:", error);
    container.innerHTML = '<p class="text-center text-danger">Error loading daily trend data.</p>';
    showToast('Failed to render daily completions trend.');
  }
}

function showToast(message) {
  const id = 'toast'+Date.now();
  const html = `
    <div id="${id}" class="toast align-items-center text-white bg-primary border-0" role="alert" aria-live="assertive">
      <div class="d-flex">
        <div class="toast-body">${esc(message)}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>
    </div>`;
  document.getElementById('toastContainer').insertAdjacentHTML('beforeend', html);
  const t = new bootstrap.Toast(document.getElementById(id), { delay: 3000 });
  t.show();
}

// Placeholder, will be implemented later
async function populateEmployeeFilter() {
  try {
    const res = await fetch('/api/admin/employees', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Failed to fetch employees for filter');
    const employees = await res.json();
    const select = document.getElementById('taskFilterEmployee');
    // Clear existing options except the "All Employees" default
    select.options.length = 1;
    employees.forEach(emp => {
      const option = document.createElement('option');
      option.value = emp.id;
      option.textContent = emp.name;
      select.appendChild(option);
    });
  } catch (error) {
    console.error("Error populating employee filter:", error);
    showToast('Could not load employees for filtering.');
  }
}

// --- Tab Auto-Refresh Logic ---
function setupTabListeners() {
    const logTabEl = document.querySelector('button[data-bs-target="#logTab"]');
    const checkoutTabEl = document.querySelector('button[data-bs-target="#checkoutTab"]');
    const taskTabEl = document.querySelector('button[data-bs-target="#taskTab"]');
    const empTabEl = document.querySelector('button[data-bs-target="#empTab"]');
    const statsTabEl = document.querySelector('button[data-bs-target="#statsTab"]');
    const catTabEl = document.querySelector('button[data-bs-target="#catTab"]');

    if (logTabEl) {
        logTabEl.addEventListener('shown.bs.tab', function (event) {
            loadLogs(1);
        });
    }
    if (checkoutTabEl) {
        checkoutTabEl.addEventListener('shown.bs.tab', function (event) {
            loadCheckouts();
        });
    }
    if (taskTabEl) {
        taskTabEl.addEventListener('shown.bs.tab', function (event) {
            loadTasks();
        });
    }
    if (empTabEl) {
        empTabEl.addEventListener('shown.bs.tab', function (event) {
            loadEmployees();
        });
    }
    if (statsTabEl) {
        statsTabEl.addEventListener('shown.bs.tab', function (event) {
            loadStats();
        });
    }
    if (catTabEl) {
        catTabEl.addEventListener('shown.bs.tab', function (event) {
            loadCategoriesList();
        });
    }
}

// --- Patch DOMContentLoaded for tolerance and tab listeners ---
document.addEventListener('DOMContentLoaded', () => {
    // Tolerance suggestion event
    const catSelect = document.getElementById('modalTaskCategory');
    if (catSelect && !catSelect.dataset.listenerAttached) {
      catSelect.addEventListener('change', suggestTolerance);
      catSelect.dataset.listenerAttached = 'true';
    }
    // Modal show event for new task
    const taskModalElement = document.getElementById('taskModal');
    if (taskModalElement && !taskModalElement.dataset.listenerAttached) {
        taskModalElement.addEventListener('show.bs.modal', () => {
            if (!document.getElementById('taskId').value) {
                suggestTolerance();
            }
            // Attach listener if not already
            const catSelectInModal = document.getElementById('modalTaskCategory');
            if(catSelectInModal && !catSelectInModal.dataset.listenerAttached) {
                catSelectInModal.addEventListener('change', suggestTolerance);
                catSelectInModal.dataset.listenerAttached = 'true';
            }
            toggleToleranceInput();
        });
        taskModalElement.dataset.listenerAttached = 'true';
    }
    // Existing log search listener
    const logSearchInput = document.getElementById('logSearch');
    if(logSearchInput && !logSearchInput.dataset.listenerAttached) {
        logSearchInput.addEventListener('input', debounce(() => loadLogs(1), 400));
        logSearchInput.dataset.listenerAttached = 'true';
    }
    // --- UX polish: add event listener for no_timeout checkbox ---
    const noTimeoutCheckbox = document.getElementById('taskNoTimeout');
    const tolInput = document.getElementById('taskTol');
    if (noTimeoutCheckbox && tolInput && !noTimeoutCheckbox.dataset.listenerAttached) {
      noTimeoutCheckbox.addEventListener('change', toggleToleranceInput);
      noTimeoutCheckbox.dataset.listenerAttached = 'true';
    }
    
    // --- Instead of attaching to a specific #taskRows, use event delegation on the entire accordion ---
    const tasksAccordion = document.getElementById('adminTasksAccordion');
    if (tasksAccordion && !tasksAccordion.dataset.clickListenerAttached) {
        tasksAccordion.addEventListener('click', function(event) {
            // Delegate to handleTaskRowClick if the click is on a task title
            const titleCell = event.target.closest('.task-title-clickable');
            if (titleCell) {
                const row = titleCell.closest('tr[data-task-data]');
                if (row) {
                    try {
                        const taskData = JSON.parse(row.dataset.taskData);
                        if (taskData && typeof taskData === 'object' && taskData.id !== undefined) {
                            showAdminTaskDetails(taskData);
                        }
                    } catch (e) {
                        console.error("Failed to parse task data for title click:", e);
                        showToast("Error opening task details.");
                    }
                }
            }
        });
        tasksAccordion.dataset.clickListenerAttached = 'true';
    }
    // Attach listeners for "Check All" checkboxes (delegated to accordion)
    if (tasksAccordion && !tasksAccordion.dataset.checkAllListenerAttached) {
        tasksAccordion.addEventListener('change', handleCategoryCheckAllChange);
        tasksAccordion.dataset.checkAllListenerAttached = 'true';
    }
    // --- Initialize Admin Task Detail Modal if not already done ---
    const adminModalElement = document.getElementById('adminTaskDetailModal');
    if (adminModalElement && !adminTaskDetailModal) {
        adminTaskDetailModal = new bootstrap.Modal(adminModalElement);
    }
});

// --- Admin Task Detail Modal Functions ---
async function showAdminTaskDetails(task) {
    if (!adminTaskDetailModal || !task) return;

    currentAdminModalTaskId = task.id;
    currentAdminModalTask = task; // Store task data

    document.getElementById('adminModalTaskTitle').textContent = task.title || 'Task Details';
    document.getElementById('adminModalTaskDescription').textContent = task.description || 'No description provided.';

    // Reset comment section
    document.getElementById('adminModalCommentList').innerHTML = '<li class="text-center text-muted" id="adminCommentsLoading">Loading comments...</li>';
    document.getElementById('adminNewCommentText').value = '';
    document.getElementById('adminCommentError').classList.add('d-none');
    document.getElementById('adminCommentError').textContent = '';

    // Show/hide Mark Read button based on unread status
    const markReadBtn = document.getElementById('adminMarkReadBtn');
    if (currentAdminModalTask?.hasUnreadComments) {
        markReadBtn.classList.remove('d-none');
    } else {
        markReadBtn.classList.add('d-none');
    }

    await fetchAdminComments(task.id);
    adminTaskDetailModal.show();
}

async function fetchAdminComments(taskId) {
    const commentList = document.getElementById('adminModalCommentList');
    const loadingIndicator = document.getElementById('adminCommentsLoading');

    try {
        const res = await fetch(`/api/admin/tasks/${taskId}/comments`, { // Use admin endpoint
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(`Failed to fetch comments (${res.status})`);
        const comments = await res.json();

        commentList.innerHTML = ''; // Clear loading/previous

        if (comments.length === 0) {
            commentList.innerHTML = '<li class="text-center text-muted small">No comments yet.</li>';
        } else {
            comments.forEach(comment => {
                const li = document.createElement('li');
                li.className = 'mb-2 pb-2 border-bottom';
                li.style.fontSize = '0.9em';

                const strong = document.createElement('strong');
                strong.textContent = `${comment.Employee?.name || 'Unknown'} (${comment.Employee?.role || 'N/A'})`;

                const small = document.createElement('small');
                small.className = 'text-muted ms-1';
                small.textContent = `(${comment.created_at || '???'})`;

                const p = document.createElement('p');
                p.className = 'mb-0 ms-1';
                p.textContent = comment.comment_text || '';

                li.appendChild(strong);
                li.appendChild(small);
                li.appendChild(p);
                commentList.appendChild(li);
            });
            commentList.scrollTop = commentList.scrollHeight;
        }

    } catch (error) {
        console.error("Admin: Error fetching comments:", error);
        if (loadingIndicator) loadingIndicator.remove();
        commentList.innerHTML = `<li class="text-center text-danger small">Could not load comments.</li>`;
    }
}

async function addAdminComment() {
    const commentText = document.getElementById('adminNewCommentText').value.trim();
    const commentError = document.getElementById('adminCommentError');
    const addCommentBtn = document.getElementById('adminAddCommentBtn');

    if (!commentText) {
        commentError.textContent = 'Comment cannot be empty.';
        commentError.classList.remove('d-none');
        return;
    }
    if (!currentAdminModalTaskId) {
         commentError.textContent = 'Error: No task selected.';
         commentError.classList.remove('d-none');
        return;
    }

     addCommentBtn.disabled = true;
     addCommentBtn.textContent = 'Adding...';
     commentError.classList.add('d-none');

    try {
        const res = await fetch(`/api/admin/tasks/${currentAdminModalTaskId}/comments`, { // Use admin endpoint
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ commentText })
        });

        if (!res.ok) {
             const errorData = await res.json().catch(() => ({ msg: `Failed to add comment (${res.status})` }));
            throw new Error(errorData.msg || `HTTP error ${res.status}`);
        }

        document.getElementById('adminNewCommentText').value = '';
        await fetchAdminComments(currentAdminModalTaskId); // Refresh list
        await markAdminCommentsRead(); // Mark the new comment read for the admin

    } catch (error) {
        console.error("Admin: Error adding comment:", error);
        commentError.textContent = `Error: ${error.message}`;
        commentError.classList.remove('d-none');
    } finally {
         addCommentBtn.disabled = false;
         addCommentBtn.textContent = 'Add Comment';
    }
}

// Placeholder for Phase 2
async function markAdminCommentsRead() {
    if (!currentAdminModalTaskId) return;
    const markReadBtn = document.getElementById('adminMarkReadBtn');
    markReadBtn.disabled = true;
    markReadBtn.textContent = 'Marking...';
    try {
        const res = await fetch(`/api/admin/tasks/${currentAdminModalTaskId}/mark-read`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) {
            const errorData = await res.json().catch(()=>({}));
            throw new Error(errorData.msg || `Failed to mark comments read (${res.status})`);
        }
        // Success: Hide button and update UI
        markReadBtn.classList.add('d-none');
        removeUnreadHighlightFromTaskRow(currentAdminModalTaskId);
        if (currentAdminModalTask) currentAdminModalTask.hasUnreadComments = false;
    } catch(err) {
        console.error("Admin: Error marking comments read:", err);
        document.getElementById('adminCommentError').textContent = `Error: ${err.message}`;
        document.getElementById('adminCommentError').classList.remove('d-none');
    } finally {
        markReadBtn.disabled = false;
        markReadBtn.textContent = 'Mark Comments As Read';
    }
}

// --- Helper to remove highlight from admin table row ---
function removeUnreadHighlightFromTaskRow(taskId) {
    const taskRow = document.getElementById(`admin-task-row-${taskId}`);
    if (taskRow) {
        taskRow.classList.remove('task-unread-comments');
        const badge = taskRow.querySelector('.unread-badge');
        if (badge) badge.remove();
    }
}

// --- Add this function near the other helpers ---
function handleTaskRowClick(event) {
    const row = event.target.closest('tr[data-task-data]');
    if (!row) return;
    const target = event.target;
    if (target.matches('input.task-checkbox') ||
        target.closest('button.btn-outline-primary') ||
        target.closest('button.btn-outline-danger')) {
        return;
    }
    try {
        const taskData = JSON.parse(row.dataset.taskData);
        if (taskData && typeof taskData === 'object' && taskData.id !== undefined) {
            showAdminTaskDetails(taskData);
        } else {
            console.error("Invalid task data found on row:", row.dataset.taskData);
            showToast("Could not load task details.");
        }
    } catch (e) {
        console.error("Failed to parse task data for row click:", e);
        showToast("Error opening task details.");
    }
}

// --- Tolerance Suggestion Logic ---
function suggestTolerance() {
    // grab the ***category*** dropdown, not a non-existent taskFreq element
    const catSel = document.getElementById('modalTaskCategory');
    // use the option's **text** (e.g. "daily", "weekly", etc.)
    const freq = catSel.options[catSel.selectedIndex].text.toLowerCase();
    const tolInput = document.getElementById('taskTol');
    let suggested = 24;
    if (freq === 'weekly') {
      suggested = 7 * 24;
    } else if (freq === 'monthly') {
      suggested = 30 * 24;
    } else if (freq === 'opening' || freq === '8pm-9pm' || freq === 'closing') {
      suggested = 2;
    } else if (freq === 'party') {
      suggested = 6;
    }
    // only overwrite on a brand-new task, or if it's still the default
    if (!document.getElementById('taskId').value || tolInput.value === '24') {
      tolInput.value = suggested;
    }
}

// Moved toggleToleranceInput to global scope so showTaskModal can call it
function toggleToleranceInput() {
  const noTimeoutCheckbox = document.getElementById('taskNoTimeout');
  const tolInput = document.getElementById('taskTol');
  if (tolInput && noTimeoutCheckbox) {
    tolInput.disabled = noTimeoutCheckbox.checked;
  }
}

// ---------- Bulk Assign Logic ----------
// Enable/disable the bulk assign button based on selection
function updateBulkAssignButtonState() {
    const btn = document.getElementById('bulkAssignBtn');
    if (btn) {
        btn.disabled = selectedTaskIdsForBulkAssign.length === 0;
    }
    const countSpan = document.getElementById('bulkAssignTaskCount');
    if(countSpan) {
        countSpan.textContent = selectedTaskIdsForBulkAssign.length;
    }
}

// Handle individual task checkbox changes
function handleTaskCheckboxChange(event) {
    if (event.target.classList.contains('task-checkbox')) {
        const taskId = parseInt(event.target.value, 10);
        if (event.target.checked) {
            if (!selectedTaskIdsForBulkAssign.includes(taskId)) {
                selectedTaskIdsForBulkAssign.push(taskId);
            }
        } else {
            const index = selectedTaskIdsForBulkAssign.indexOf(taskId);
            if (index > -1) {
                selectedTaskIdsForBulkAssign.splice(index, 1);
            }
        }
        updateBulkAssignButtonState();
        // Also update the category 'check all' state if necessary
        const tbody = event.target.closest('tbody');
        if(tbody) {
            const headerCheckboxId = tbody.id.replace('tbody-', 'check-all-');
            const headerCheckbox = document.getElementById(headerCheckboxId);
            if(headerCheckbox) {
                 const allCheckboxes = tbody.querySelectorAll('.task-checkbox');
                 const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
                 const someChecked = Array.from(allCheckboxes).some(cb => cb.checked);
                 headerCheckbox.checked = allChecked;
                 headerCheckbox.indeterminate = !allChecked && someChecked;
            }
        }
    }
}

// Handle category "Check All" checkbox changes (using event delegation on accordion)
function handleCategoryCheckAllChange(event) {
    if (event.target.classList.contains('category-check-all')) {
        const headerCheckbox = event.target;
        const targetTbodyId = headerCheckbox.dataset.targetTbody;
        const tbody = document.getElementById(targetTbodyId);
        if (!tbody) return;

        const taskCheckboxes = tbody.querySelectorAll('.task-checkbox');
        const isCheckingAll = headerCheckbox.checked;
        headerCheckbox.indeterminate = false; // Clear indeterminate state on click

        taskCheckboxes.forEach(checkbox => {
            const taskId = parseInt(checkbox.value, 10);
            checkbox.checked = isCheckingAll;

            if (isCheckingAll) {
                // Add to selection if not already present
                if (!selectedTaskIdsForBulkAssign.includes(taskId)) {
                    selectedTaskIdsForBulkAssign.push(taskId);
                }
            } else {
                // Remove from selection
                const index = selectedTaskIdsForBulkAssign.indexOf(taskId);
                if (index > -1) {
                    selectedTaskIdsForBulkAssign.splice(index, 1);
                }
            }
        });
        updateBulkAssignButtonState();
    }
}

// Load employees into the bulk assign modal
async function loadEmployeesForBulkAssignModal() {
    const listDiv = document.getElementById('bulkAssignEmployeeList');
    listDiv.innerHTML = '<div class="text-center p-3 text-muted small">Loading...</div>';
    try {
        const empRes = await fetch('/api/admin/employees', { headers: { Authorization: `Bearer ${token}` } });
        if (!empRes.ok) throw new Error('Failed to load employees');
        const employees = await empRes.json();
        listDiv.innerHTML = '';
        if (employees.length === 0) {
            listDiv.innerHTML = '<div class="text-center p-3 text-muted small">No employees found.</div>'; return;
        }
        employees.forEach(emp => {
            const div = document.createElement('div');
            div.className = 'form-check';
            div.innerHTML = `<input class="form-check-input" type="checkbox" value="${emp.id}" id="bulkAssignEmpCheck-${emp.id}"><label class="form-check-label" for="bulkAssignEmpCheck-${emp.id}">${esc(emp.name)}</label>`;
            listDiv.appendChild(div);
        });
    } catch (error) {
        console.error("Error loading employees for bulk assign modal:", error);
        listDiv.innerHTML = '<div class="alert alert-danger p-2 small">Could not load employee data.</div>';
        showToast('Error loading employees.');
    }
}

// Show the bulk assign modal
async function showBulkAssignModal() {
    if (selectedTaskIdsForBulkAssign.length === 0) {
        showToast('Please select at least one task to assign.');
        return;
    }
    await loadEmployeesForBulkAssignModal(); // Load fresh list each time
    bulkAssignModal.show();
}

// Execute the bulk assignment API call
async function executeBulkAssign() {
    const selectedEmployeeIds = Array.from(
        document.querySelectorAll('#bulkAssignEmployeeList input:checked')
    ).map(input => parseInt(input.value, 10));

    if (selectedTaskIdsForBulkAssign.length === 0) {
        showToast('No tasks selected.'); // Should be prevented by button state, but double-check
        return;
    }

    const saveButton = document.querySelector('#bulkAssignModal .btn-primary');
    saveButton.disabled = true;
    saveButton.textContent = 'Assigning...';

    try {
        // Step 1: Check category access first
        const checkUrl = `/api/admin/bulk-check-category-access?taskIds=${selectedTaskIdsForBulkAssign.join(',')}&employeeIds=${selectedEmployeeIds.join(',')}`;
        const checkRes = await fetch(checkUrl, { headers: { Authorization: `Bearer ${token}` } });

        if (!checkRes.ok) {
            const errorData = await checkRes.json().catch(() => ({}));
            throw new Error(errorData.msg || `Failed to check category access (${checkRes.status})`);
        }

        const { employeesWithoutAccess } = await checkRes.json();

        let proceedWithAssignment = false;
        let grantAndAssign = false;

        if (employeesWithoutAccess && employeesWithoutAccess.length > 0) {
            // Step 2a: Prompt admin if access is missing
            let confirmationMessage = 'The following employees need access granted to categories for some selected tasks:\n\n';
            employeesWithoutAccess.forEach(item => {
                const missingCats = item.missingCategories.map(cat => cat.name).join(', ');
                confirmationMessage += `- ${item.employee.name}: Needs access to [${missingCats}]\n`;
            });
            confirmationMessage += '\nGrant necessary category access and assign tasks?';

            if (confirm(confirmationMessage)) {
                proceedWithAssignment = true;
                grantAndAssign = true; // Flag to use the grant+assign endpoint
            } else {
                // Admin cancelled
                showToast('Bulk assignment cancelled.');
                // No need to reset button text/state here, finally block handles it
            }
        } else {
            // Step 2b: Everyone has access
            proceedWithAssignment = true;
            grantAndAssign = false; // Flag to use the standard assign endpoint
        }

        // Step 3: Call appropriate backend endpoint if proceeding
        if (proceedWithAssignment) {
            const apiUrl = grantAndAssign
                ? '/api/admin/bulk-assign-and-grant-category' // New endpoint
                : '/api/admin/tasks/bulk-assign';          // Original endpoint

            const apiRes = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ taskIds: selectedTaskIdsForBulkAssign, employeeIds: selectedEmployeeIds })
            });

            if (!apiRes.ok) {
                 const errorData = await apiRes.json().catch(() => ({}));
                 throw new Error(errorData.msg || `Failed API call (${apiRes.status})`);
            }

            const successData = await apiRes.json();
            showToast(successData.msg || `Successfully updated ${selectedTaskIdsForBulkAssign.length} task(s).`);
            bulkAssignModal.hide();
            selectedTaskIdsForBulkAssign = []; // Clear selection
            await loadTasks(); // Reload task list to show changes & reset checkboxes/button
        }
    } catch (error) {
        console.error("Error during bulk assignment execution:", error);
        showToast(`Error: ${error.message}`);
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = 'Assign';
    }
} 