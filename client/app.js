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

let currentTheme = 'light'; // Variable to store theme
let taskDetailModal = null;
let currentModalTaskId = null; // To keep track of which task is open
let employeeStatsChartInstance = null;
let lastEmployeeStatsData = null;
let tasksByCategoryGlobal = {};
let currentSelectedCategory = null;

let overdueCheckIntervalId = null; // For tracking the interval timer
const OVERDUE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// --- NEW: Function to apply theme ---
function applyTheme(theme) {
    if (theme === 'dark') {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
    }
    currentTheme = theme;
    // Update button text/icon if it exists
    const toggleBtn = document.getElementById('themeToggleBtn');
    if (toggleBtn) {
        toggleBtn.textContent = theme === 'dark' ? '☀️ Light' : '🌙 Dark';
    }
    // Re-render chart if it exists to update colors
    if (employeeStatsChartInstance && lastEmployeeStatsData) {
        renderEmployeePieChart(lastEmployeeStatsData);
    }
}

// --- NEW: Function to toggle theme ---
async function toggleTheme() {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    try {
        const res = await fetch('/api/user/theme', {
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
        // Only apply if saved successfully
        applyTheme(newTheme);
    } catch (error) {
        console.error('Theme toggle error:', error);
        alert('Could not save theme preference. Please try again.');
    }
}

// Populate the employee dropdown on page load
window.addEventListener('DOMContentLoaded', async () => {
  try {
    // hits your public employees endpoint; adjust path if needed
    const res = await fetch('/api/employees/list');
    if (!res.ok) throw new Error('Fetch failed');
    const list = await res.json();
    const select = document.getElementById('employeeSelect');
    // clear placeholder
    select.innerHTML = '<option value="" disabled selected>Select your name</option>';
    list.forEach(emp => {
      const opt = document.createElement('option');
      opt.value = emp.id;
      opt.textContent = emp.name;
      select.appendChild(opt);
    });

    // Initialize the Bootstrap modal instance
    const modalElement = document.getElementById('taskDetailModal');
    if (modalElement) {
        taskDetailModal = new bootstrap.Modal(modalElement);
    }
  } catch (err) {
    console.error('Could not load employees:', err);
    const select = document.getElementById('employeeSelect');
    select.innerHTML = '<option disabled>Error loading employees</option>';
  }
});

// ---------- login ----------
async function login() {
  const pin = document.getElementById('pin').value.trim();
  const employeeId = document.getElementById('employeeSelect').value;

  if (!employeeId) return alert('Please select your name.');
  if (!pin) return alert('PIN required');

  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId, pin })
  });
  if (!res.ok) return alert('Bad PIN');
  const data = await res.json();
  token = data.token;

  // --- APPLY THEME ---
  applyTheme(data.theme || 'light'); // Use fetched theme, default to light

  document.getElementById('welcome').innerText =
    `Hi, ${data.name}. Please complete your checklist:`;
  document.getElementById('loginPane').classList.add('d-none');
  document.getElementById('taskPane').classList.remove('d-none');

  // --- ADD THEME TOGGLE BUTTON ---
  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'themeToggleBtn';
  toggleBtn.className = 'btn btn-sm btn-outline-secondary';
  toggleBtn.onclick = toggleTheme;
  // Set initial text based on applied theme
  toggleBtn.textContent = currentTheme === 'dark' ? '☀️ Light' : '🌙 Dark';

  // --- GET THE CONTAINER ---
  const userControlsContainer = document.getElementById('userControlsContainer');
  if (userControlsContainer) {
      userControlsContainer.appendChild(toggleBtn);

      // --- ADD LOGOUT BUTTON ---
      const logoutBtn = document.createElement('button');
      logoutBtn.id = 'logoutBtn';
      logoutBtn.className = 'btn btn-sm btn-outline-danger'; // Use danger color for logout
      logoutBtn.textContent = 'Logout';
      logoutBtn.onclick = logout; // Assign the new logout function
      userControlsContainer.appendChild(logoutBtn); // Add it to the container
  }

  loadTasks();
  loadEmployeeStats();
  startOverdueChecker();

  // --- ADD TUTORIAL ALERT ---
  const tutorialPlaceholder = document.getElementById('tutorialAlertPlaceholder');
  if (tutorialPlaceholder) {
      tutorialPlaceholder.innerHTML = `
          <div class="alert alert-info alert-dismissible fade show" role="alert">
              <strong>Quick Guide:</strong>
              <ol class="mb-0 mt-1 small">
                  <li>Select a <strong>Category</strong> on the left.</li>
                  <li>Check the boxes for tasks you've completed.</li>
                  <li>Click the green <strong>"Log Completed Tasks"</strong> button below the list.</li>
                  <li>To add notes, click a task title to open details & comments.</li>
              </ol>
              <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
          </div>
      `;
      // Ensure the alert is fully interactive
      if (window.bootstrap && window.bootstrap.Alert) {
        new bootstrap.Alert(tutorialPlaceholder.querySelector('.alert'));
      }
  }
  // --- END TUTORIAL ALERT ---
}

// Function to check and update overdue status in real-time
function checkAndUpdateOverdueStatus() {
    if (!currentSelectedCategory || !tasksByCategoryGlobal[currentSelectedCategory]) {
        // Not logged in, or category/tasks not loaded yet
        return;
    }

    const tasksToCheck = tasksByCategoryGlobal[currentSelectedCategory];
    const now = Date.now();
    let currentOverdueCount = 0; // Initialize counter for overdue tasks

    tasksToCheck.forEach(task => {
        // Ensure the task object has the necessary fields from the modified API
        if (task.tolerance_hours === undefined || task.no_timeout === undefined) {
            console.warn(`Task ${task.id} is missing tolerance_hours or no_timeout property.`);
            return; // Skip if data is missing
        }

        const taskElement = document.getElementById(`task-item-${task.id}`);
        if (!taskElement) return; // Element not in DOM

        let isNowOverdue = false;
        // Use the raw timestamp field added in Step 1
        const lastDoneTimestamp = task.last_done_timestamp ? new Date(task.last_done_timestamp).getTime() : null;

        if (task.no_timeout) {
            // Overdue only if never completed
            isNowOverdue = lastDoneTimestamp === null;
        } else if (lastDoneTimestamp !== null) {
            // Normal task, has been completed, check tolerance
            const hoursSince = (now - lastDoneTimestamp) / 3.6e6; // 3.6e6 = 1000 * 60 * 60
            isNowOverdue = hoursSince > task.tolerance_hours;
        } else {
            // Normal task, never completed. Considered overdue.
            isNowOverdue = true;
        }

        // Update UI class based on the live check
        if (isNowOverdue) {
            currentOverdueCount++; // Increment overdue counter
            if (!taskElement.classList.contains('list-group-item-danger')) {
                taskElement.classList.add('list-group-item-danger');
            }
            // If it just became overdue, REMOVE the completed strikethrough
            if (taskElement.classList.contains('task-completed')) {
                taskElement.classList.remove('task-completed');
            }
        } else {
            if (taskElement.classList.contains('list-group-item-danger')) {
                taskElement.classList.remove('list-group-item-danger');
            }
            // If it's not overdue AND it has been completed, ADD strikethrough back
            if (lastDoneTimestamp !== null && !taskElement.classList.contains('task-completed')) {
                taskElement.classList.add('task-completed');
            }
        }
        
        // Also update the task's overdue property in our global data structure
        task.overdue = isNowOverdue;
    });
    
    // After loop: Update the category badge
    try {
        const categoryButton = document.querySelector(`#categoryListContainer button[data-category="${currentSelectedCategory}"]`);
        
        if (!categoryButton) {
            console.error(`Could not find category button for: ${currentSelectedCategory}`);
            return;
        }
        
        const badgesContainer = categoryButton.querySelector('.category-badges');
        if (!badgesContainer) {
            console.error(`Could not find badge container in button for: ${currentSelectedCategory}`);
            return;
        }
        
        let overdueBadge = badgesContainer.querySelector('.category-overdue-badge');
        
        if (currentOverdueCount > 0) {
            const badgeText = `${currentOverdueCount} Overdue`;
            if (overdueBadge) {
                // Update existing badge
                overdueBadge.textContent = badgeText;
            } else {
                // Create new badge if it didn't exist
                overdueBadge = document.createElement('span');
                overdueBadge.className = 'badge bg-danger rounded-pill ms-1 category-overdue-badge';
                overdueBadge.textContent = badgeText;
                badgesContainer.appendChild(overdueBadge);
            }
        } else {
            // No overdue items, remove badge if it exists
            if (overdueBadge) {
                overdueBadge.remove();
            }
        }
    } catch(e) {
        console.error("Error updating category badge:", e);
    }
}

// Functions to start and stop the overdue checker
function startOverdueChecker() {
    stopOverdueChecker(); // Clear any existing interval first
    console.log(`Starting overdue checker (every ${OVERDUE_CHECK_INTERVAL_MS / 1000} seconds)`);
    overdueCheckIntervalId = setInterval(checkAndUpdateOverdueStatus, OVERDUE_CHECK_INTERVAL_MS);
    // Run the check immediately once after login/load
    setTimeout(checkAndUpdateOverdueStatus, 1000);
}

function stopOverdueChecker() {
    if (overdueCheckIntervalId) {
        console.log("Stopping overdue checker.");
        clearInterval(overdueCheckIntervalId);
        overdueCheckIntervalId = null;
    }
}

// REPLACE the existing renderOneTaskInto function with this:
function renderOneTaskInto(parent, t) {
    const collapseId = `task-desc-${t.id}`;
    const hasDescription = t.description && t.description.trim() !== '';
    let detailsButton = null;

    const itemDiv = document.createElement('div');
    itemDiv.className = `list-group-item ${t.overdue ? 'list-group-item-danger' : ''} ${t.completed_within_tolerance ? 'task-completed' : ''}`;
    itemDiv.id = `task-item-${t.id}`; // Ensure this ID is set

    const topFlexDiv = document.createElement('div');
    topFlexDiv.className = 'd-flex w-100 justify-content-between align-items-start';

    const mainContentDiv = document.createElement('div');
    mainContentDiv.className = 'me-auto';

    const checkbox = document.createElement('input');
    checkbox.className = 'form-check-input me-2 align-middle';
    checkbox.type = 'checkbox';
    checkbox.value = t.id;
    checkbox.id = `task-check-${t.id}`;
    checkbox.addEventListener('click', (e) => e.stopPropagation());

    const titleSpan = document.createElement('span');
    titleSpan.textContent = t.title;
    titleSpan.className = 'fw-bold align-middle task-title-clickable ms-1';
    titleSpan.addEventListener('click', (e) => {
        e.stopPropagation();       // prevent bubbling to list item
        showTaskDetails(t);
    });

    const lastDoneSmall = document.createElement('small');
    lastDoneSmall.className = 'd-block text-muted';
    lastDoneSmall.style.fontSize = '0.8em';
    lastDoneSmall.textContent = `Last done: ${t.last_done || 'never'}${t.lastBy ? ' by ' + t.lastBy : ''}`;

    mainContentDiv.appendChild(checkbox);
    mainContentDiv.appendChild(titleSpan);
    mainContentDiv.appendChild(lastDoneSmall);

    topFlexDiv.appendChild(mainContentDiv);

    if (hasDescription) {
        detailsButton = document.createElement('button');
        detailsButton.className = 'btn btn-sm btn-outline-secondary py-0 px-1 ms-2 flex-shrink-0 d-flex align-items-center';
        detailsButton.setAttribute('type', 'button');
        detailsButton.setAttribute('data-bs-toggle', 'collapse');
        detailsButton.setAttribute('data-bs-target', `#${collapseId}`);
        detailsButton.setAttribute('aria-expanded', 'false');
        detailsButton.setAttribute('aria-controls', collapseId);
        const downArrow = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M1.5 6l6 6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
        const upArrow = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M1.5 10l6-6 6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
        detailsButton.innerHTML = `${downArrow}<span class="ms-1">Show Description</span>`;
        detailsButton.style.lineHeight = '1';
        detailsButton.addEventListener('click', (e) => e.stopPropagation());
        topFlexDiv.appendChild(detailsButton);
        setTimeout(() => {
            const collapseDiv = document.getElementById(collapseId);
            if (!collapseDiv) return;
            if (!collapseDiv.dataset.listenersAttached) {
                 collapseDiv.addEventListener('show.bs.collapse', () => { detailsButton.innerHTML = `${upArrow}<span class="ms-1">Hide Description</span>`; });
                 collapseDiv.addEventListener('hide.bs.collapse', () => { detailsButton.innerHTML = `${downArrow}<span class="ms-1">Show Description</span>`; });
                 collapseDiv.dataset.listenersAttached = 'true';
            }
        }, 0);
    }

    // --- UNREAD COMMENTS INDICATOR ---
    if (t.hasUnreadComments) {
        console.log(`Applying unread style to Task ID: ${t.id}`);
        itemDiv.classList.add('task-unread-comments');
        titleSpan.insertAdjacentHTML('beforeend', ' <span class="badge rounded-pill bg-info unread-badge">New Comment</span>');
    }

    itemDiv.appendChild(topFlexDiv);

    if (hasDescription) {
        const collapseDiv = document.createElement('div');
        collapseDiv.className = 'collapse mt-2';
        collapseDiv.id = collapseId;
        const descriptionP = document.createElement('p');
        descriptionP.className = 'mb-0 text-muted task-description-text';
        descriptionP.style.fontSize = '0.9em';
        descriptionP.textContent = t.description;
        collapseDiv.appendChild(descriptionP);
        itemDiv.appendChild(collapseDiv);
    }

    // Make the entire item clickable, except for checkbox and description toggle
    itemDiv.style.cursor = 'pointer';
    itemDiv.addEventListener('click', (event) => {
        // Prevent modal open if click is ON the checkbox, the description button, or inside the description button
        if (event.target.matches('.form-check-input') || (detailsButton && detailsButton.contains(event.target))) {
            return; // Do nothing, let the checkbox/button handle its own event
        }
        showTaskDetails(t);
    });

    parent.appendChild(itemDiv);
}

// ---------- load tasks ----------
async function loadTasks() {
    const categoryListContainer = document.getElementById('categoryListContainer');
    const taskListContainer = document.getElementById('taskListContainer');
    const taskListHeader = document.getElementById('taskListHeader');

    categoryListContainer.innerHTML = '<div class="text-center p-3 text-muted">Loading categories...</div>';
    taskListContainer.innerHTML = '<div class="text-center p-3 text-muted">Loading tasks...</div>';
    taskListHeader.textContent = 'Tasks'; // Reset header

    try {
        const res = await fetch('/api/tasks', {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) {
            const msg = await res.text();
            throw new Error(`/api/tasks ${res.status}: ${msg}`);
        }
        const tasks = await res.json();
        console.log('Tasks received by employee:', tasks);

        // --- Group tasks by category ---
        tasksByCategoryGlobal = {}; // Reset global store
        const categoryOrder = new Map(); // Track category order

        tasks.forEach(task => {
            const categoryName = task.categoryName || 'Uncategorized';
            if (!tasksByCategoryGlobal[categoryName]) {
                tasksByCategoryGlobal[categoryName] = [];
                categoryOrder.set(categoryName, task.Category?.sort_order || 0);
            }
            tasksByCategoryGlobal[categoryName].push(task);
        });

        // Sort tasks within each category by sort_order
        Object.keys(tasksByCategoryGlobal).forEach(categoryName => {
            tasksByCategoryGlobal[categoryName].sort((a, b) => a.sort_order - b.sort_order);
        });

        // --- Populate Category List (Left Column) ---
        categoryListContainer.innerHTML = ''; // Clear loading message

        // Sort categories by their sort_order
        const sortedCategoryNames = Array.from(categoryOrder.entries())
            .sort((a, b) => a[1] - b[1])
            .map(([name]) => name);

        if (sortedCategoryNames.length === 0) {
            categoryListContainer.innerHTML = '<div class="list-group-item text-muted">No tasks assigned.</div>';
            taskListContainer.innerHTML = ''; // Clear right side too
            taskListHeader.textContent = 'Tasks';
            return;
        }

        // Create category list items
        sortedCategoryNames.forEach(categoryName => {
            const categoryTasks = tasksByCategoryGlobal[categoryName] || [];
            const unreadCount = categoryTasks.filter(t => t.hasUnreadComments).length;
            const overdueCount = categoryTasks.filter(t => t.overdue).length;
            
            const categoryLink = document.createElement('button');
            categoryLink.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-center';
            categoryLink.onclick = () => displayTasksForCategory(categoryName);
            categoryLink.dataset.category = categoryName; // Add data attribute for easier selection
            
            // Title span (left side)
            const titleSpan = document.createElement('span');
            titleSpan.textContent = categoryName;
            
            // Badges Span (container for multiple badges)
            const badgesSpan = document.createElement('span');
            badgesSpan.className = 'category-badges'; // Add class for easier selection
            
            // Unread Comments Badge (if any)
            if (unreadCount > 0) {
                const unreadBadge = document.createElement('span');
                unreadBadge.className = 'badge bg-info rounded-pill ms-1';
                unreadBadge.textContent = `${unreadCount} New Comment${unreadCount !== 1 ? 's' : ''}`;
                badgesSpan.appendChild(unreadBadge);
            }
            
            // Overdue Badge (if any)
            if (overdueCount > 0) {
                const overdueBadge = document.createElement('span');
                overdueBadge.className = 'badge bg-danger rounded-pill ms-1 category-overdue-badge'; // Add specific class
                overdueBadge.textContent = `${overdueCount} Overdue`;
                badgesSpan.appendChild(overdueBadge);
            }
            
            categoryLink.appendChild(titleSpan);
            categoryLink.appendChild(badgesSpan);
            categoryListContainer.appendChild(categoryLink);
        });

        // Select first category by default
        if (sortedCategoryNames.length > 0) {
            const firstCategory = sortedCategoryNames[0];
            currentSelectedCategory = firstCategory;
            const firstButton = categoryListContainer.querySelector('.list-group-item');
            if (firstButton) firstButton.classList.add('active');
            displayTasksForCategory(firstCategory);
        }

    } catch (error) {
        console.error('Error loading tasks:', error);
        categoryListContainer.innerHTML = '<div class="alert alert-danger">Failed to load tasks</div>';
        taskListContainer.innerHTML = '';
    }
}

// Add the displayTasksForCategory function
function displayTasksForCategory(categoryName) {
    const taskListContainer = document.getElementById('taskListContainer');
    const taskListHeader = document.getElementById('taskListHeader');
    const categoryLinks = document.querySelectorAll('#categoryListContainer .list-group-item');

    console.log(`Displaying tasks for category: ${categoryName}`);
    currentSelectedCategory = categoryName; // Store the selected category

    taskListContainer.innerHTML = ''; // Clear previous tasks
    taskListHeader.textContent = `${categoryName} Tasks`; // Update header

    // Highlight the selected category in the left list
    categoryLinks.forEach(link => {
        if (link.textContent === categoryName) {
            link.classList.add('active');
        } else {
            link.classList.remove('active');
        }
    });

    const tasksToDisplay = tasksByCategoryGlobal[categoryName];

    if (!tasksToDisplay || tasksToDisplay.length === 0) {
        taskListContainer.innerHTML = '<div class="text-center p-3 text-muted">No tasks in this category.</div>';
        document.getElementById('checkoutBtn').disabled = true; // Disable button
        return;
    }

    // Render tasks into the right column
    tasksToDisplay.forEach(task => {
        renderOneTaskInto(taskListContainer, task); // Use the existing rendering function
    });

    // Re-attach event listeners for the checkboxes in the *newly rendered* task list
    updateCheckoutButtonState(); // Call the function to manage the button state
    checkAndUpdateOverdueStatus(); // Check overdue status for newly displayed tasks
}

// Add the updateCheckoutButtonState function
function updateCheckoutButtonState() {
    // Get references to BOTH buttons
    const btnBottom = document.getElementById('checkoutBtn');
    const btnTop = document.getElementById('checkoutBtnTop');
    const checkboxes = document.querySelectorAll('#taskListContainer input[type=checkbox]'); // Target right column

    // Function to update button disable state AND item style
    const handleCheckboxChange = (event) => {
        const checkbox = event.target;
        // Find the parent list-group-item div
        const taskItemDiv = checkbox.closest('.list-group-item'); // More robust way to find parent

        if (taskItemDiv) {
            if (checkbox.checked) {
                taskItemDiv.classList.add('task-checked');
            } else {
                taskItemDiv.classList.remove('task-checked');
            }
        } else {
            console.warn("Could not find parent list-group-item for checkbox:", checkbox);
        }

        const checkedCount = document.querySelectorAll('#taskListContainer input:checked').length; // Target right column
        // Update both buttons
        if (btnBottom) btnBottom.disabled = checkedCount === 0;
        if (btnTop) btnTop.disabled = checkedCount === 0;
    };

    // Remove old listeners and add new ones
    checkboxes.forEach(cb => {
        // Clone and replace to remove all old listeners cleanly
        const newCb = cb.cloneNode(true);
        cb.parentNode.replaceChild(newCb, cb);
        // Add the single listener to the new checkbox
        newCb.addEventListener('change', handleCheckboxChange);

        // Apply initial style if checkbox is already checked (e.g., if page reloads weirdly)
        // Find the parent list-group-item div for initial styling
        const initialTaskItemDiv = newCb.closest('.list-group-item');
        if (initialTaskItemDiv) {
            if (newCb.checked) {
                initialTaskItemDiv.classList.add('task-checked');
            } else {
                initialTaskItemDiv.classList.remove('task-checked');
            }
        }
    });

    // Set initial button state (call the logic once without an event)
    const initialCheckedCount = document.querySelectorAll('#taskListContainer input:checked').length;
    if (btnBottom) btnBottom.disabled = initialCheckedCount === 0;
    if (btnTop) btnTop.disabled = initialCheckedCount === 0;
}

// ---------- submit ----------
// One checkout at a time: a double tap must not log the same tasks twice.
let checkoutInFlight = false;
async function checkout() {
    if (checkoutInFlight) return;
    checkoutInFlight = true;
    try {
        await checkoutOnce();
    } finally {
        checkoutInFlight = false;
    }
}

async function checkoutOnce() {
    // Update the selector here:
    const checkedInputs = [...document.querySelectorAll('#taskListContainer input:checked')];
    const checkedTaskIds = checkedInputs.map(i => parseInt(i.value));

    // --- Frontend Pre-Check (for better UX) ---
    let hasUnreadOnSelected = false;
    let unreadTitles = [];
    for (const taskId of checkedTaskIds) {
        // The task item ID is still unique, no change needed here
        const taskItemDiv = document.getElementById(`task-item-${taskId}`);
        if (taskItemDiv && taskItemDiv.classList.contains('task-unread-comments')) {
            hasUnreadOnSelected = true;
            const titleEl = taskItemDiv.querySelector('.task-title-clickable');
            unreadTitles.push(titleEl ? titleEl.textContent.replace(' New','').trim() : `Task ID ${taskId}`);
        }
    }
    if (hasUnreadOnSelected) {
        alert(`Please review new comments before checking out the following task(s): ${unreadTitles.join(', ')}`);
        return;
    }
    // --- End Frontend Pre-Check ---

    const displayName = prompt('Type your name to sign:');
    if (!displayName) return;

    try {
        const res = await fetch('/api/tasks/complete', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ taskIds: checkedTaskIds, displayName })
        });

        if (res.ok) {
            // Instead of full reload, maybe just refresh the current category view?
            // Or reload all tasks which will preserve the current view
            await loadTasks();
            await loadEmployeeStats();
            // The updateCheckoutButtonState() is called within loadTasks -> displayTasksForCategory
            // So the button state will be correct after reload.
            return;
        } else {
            let errorMsg = `Checkout failed with status: ${res.status}`;
            try {
                const errorData = await res.json();
                if (errorData && errorData.msg) {
                    errorMsg = errorData.msg;
                }
            } catch (jsonError) {
                console.error("Could not parse error response JSON:", jsonError);
                errorMsg = res.statusText || errorMsg;
            }
            alert(`Error: ${errorMsg}`);
        }
    } catch (networkError) {
        console.error("Checkout network error:", networkError);
        alert(`Network error during checkout: ${networkError.message}. Please try again.`);
    }
}

// --- NEW: Show Task Details Modal ---
async function showTaskDetails(task) {
    if (!taskDetailModal) return;
    currentModalTaskId = task.id;
    document.getElementById('modalTaskTitle').textContent = task.title || 'Task Details';
    document.getElementById('modalTaskDescription').textContent = task.description || 'No description provided.';
    document.getElementById('modalCommentList').innerHTML = '<li class="text-center text-muted" id="commentsLoading">Loading comments...</li>';
    document.getElementById('newCommentText').value = '';
    document.getElementById('commentError').classList.add('d-none');
    document.getElementById('commentError').textContent = '';

    // --- Mark Read Button Logic ---
    console.log(`showTaskDetails: Task ${task.id}, hasUnreadComments: ${task.hasUnreadComments}`);
    const markReadBtn = document.getElementById('markReadBtn');
    if (!markReadBtn) {
        console.error("Mark Read button not found in DOM!");
        return;
    }
    if (task.hasUnreadComments) {
         console.log(` -> Should show Mark Read button for task ${task.id}`);
         markReadBtn.classList.remove('d-none');
    } else {
         console.log(` -> Should hide Mark Read button for task ${task.id}`);
         markReadBtn.classList.add('d-none');
    }

    await fetchComments(task.id);
    taskDetailModal.show();
}

// --- NEW: Fetch Comments for Modal ---
async function fetchComments(taskId) {
    const commentList = document.getElementById('modalCommentList');
    const loadingIndicator = document.getElementById('commentsLoading');
    try {
        const res = await fetch(`/api/tasks/${taskId}/comments`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) {
            throw new Error(`Failed to fetch comments (${res.status})`);
        }
        const comments = await res.json();
        commentList.innerHTML = '';
        if (comments.length === 0) {
            commentList.innerHTML = '<li class="text-center text-muted small">No comments yet.</li>';
        } else {
            comments.forEach(comment => {
                const li = document.createElement('li');
                li.className = 'mb-2 pb-2 border-bottom';
                li.style.fontSize = '0.9em';

                const strong = document.createElement('strong');
                strong.textContent = comment.Employee?.name || 'Unknown User';

                const small = document.createElement('small');
                small.className = 'text-muted ms-1';
                small.textContent = `(${comment.created_at || 'timestamp missing'})`;

                const p = document.createElement('p');
                p.className = 'mb-0 ms-1';
                p.textContent = comment.comment_text || '';

                li.appendChild(strong);
                li.appendChild(small);
                li.appendChild(p);
                commentList.appendChild(li);
            });
        }
    } catch (error) {
        console.error("Error fetching comments:", error);
        if (loadingIndicator) loadingIndicator.remove();
        commentList.innerHTML = `<li class="text-center text-danger small">Could not load comments.</li>`;
    }
}

// --- NEW: Add Comment ---
async function addComment() {
    const commentText = document.getElementById('newCommentText').value.trim();
    const commentError = document.getElementById('commentError');
    const addCommentBtn = document.getElementById('addCommentBtn');
    if (!commentText) {
        commentError.textContent = 'Comment cannot be empty.';
        commentError.classList.remove('d-none');
        return;
    }
    if (!currentModalTaskId) {
         commentError.textContent = 'Error: No task selected.';
         commentError.classList.remove('d-none');
        return;
    }
    addCommentBtn.disabled = true;
    addCommentBtn.textContent = 'Adding...';
    commentError.classList.add('d-none');
    try {
        const res = await fetch(`/api/tasks/${currentModalTaskId}/comments`, {
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
        document.getElementById('newCommentText').value = '';
        await fetchComments(currentModalTaskId);
        await markCommentsRead(); // Mark comments read for the current user
    } catch (error) {
        console.error("Error adding comment:", error);
        commentError.textContent = `Error: ${error.message}`;
        commentError.classList.remove('d-none');
    } finally {
         addCommentBtn.disabled = false;
         addCommentBtn.textContent = 'Add Comment';
    }
}

// --- NEW: Mark Comments Read (Employee) ---
async function markCommentsRead() {
    if (!currentModalTaskId) return;
    const markReadBtn = document.getElementById('markReadBtn');
    markReadBtn.disabled = true;
    markReadBtn.textContent = 'Marking...';
    let categoryNameForTask = null;
    let taskInstance = null;
    try {
        const res = await fetch(`/api/tasks/${currentModalTaskId}/mark-read`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) {
            const errorData = await res.json().catch(()=>({}));
            throw new Error(errorData.msg || `Failed to mark comments read (${res.status})`);
        }
        // Success: Hide button and update UI immediately
        markReadBtn.classList.add('d-none');
        removeUnreadHighlightFromTaskList(currentModalTaskId); // Update task item style

        // --- BEGIN: Update Category Badge ---
        // 1. Find the category name for the current task and update its state
        for (const categoryName in tasksByCategoryGlobal) {
            taskInstance = tasksByCategoryGlobal[categoryName].find(task => task.id === currentModalTaskId);
            if (taskInstance) {
                categoryNameForTask = categoryName;
                taskInstance.hasUnreadComments = false; // Update the state in our global data
                break;
            }
        }

        // 2. Update the badge in the category list if category found
        if (categoryNameForTask) {
            const categoryLink = document.querySelector(`#categoryListContainer [data-category="${categoryNameForTask}"]`);
            if (categoryLink) {
                const badgesSpan = categoryLink.querySelector('span:last-child'); // Assumes badges are in the last span
                const unreadBadge = badgesSpan?.querySelector('.bg-info.rounded-pill'); // Target the specific unread badge

                if (unreadBadge) {
                    // Calculate the new count by checking the updated tasks in the category
                    const remainingUnreadInCategory = tasksByCategoryGlobal[categoryNameForTask].filter(t => t.hasUnreadComments).length;

                    if (remainingUnreadInCategory > 0) {
                        // Update count
                        unreadBadge.textContent = `${remainingUnreadInCategory} New Comment${remainingUnreadInCategory > 1 ? 's' : ''}`;
                    } else {
                        // Remove badge if count is zero
                        unreadBadge.remove();
                    }
                }
            }
        }
        // --- END: Update Category Badge ---

    } catch(err) {
        console.error("Error marking comments read:", err);
        document.getElementById('commentError').textContent = `Error: ${err.message}`;
        document.getElementById('commentError').classList.remove('d-none');
        // Also restore the task's unread state in global data if the API call failed *after* we optimistically set it to false
         if(taskInstance) { taskInstance.hasUnreadComments = true; }

    } finally {
        markReadBtn.disabled = false; // Re-enable even on error
        markReadBtn.textContent = 'Mark Comments As Read';
    }
}

// --- Helper to remove highlight from main list ---
function removeUnreadHighlightFromTaskList(taskId) {
    const taskItemDiv = document.getElementById(`task-item-${taskId}`);
    if (taskItemDiv) {
        taskItemDiv.classList.remove('task-unread-comments');
        // Remove badge if it exists
        const badge = taskItemDiv.querySelector('.unread-badge');
        if (badge) badge.remove();
    }
}

// --- NEW: Render Employee Pie Chart ---
function renderEmployeePieChart(rows) {
    const ctx = document.getElementById('employeeStatsChart')?.getContext('2d');
    if (!ctx) {
        console.error("Cannot find canvas element for employee stats chart.");
        return;
    }

    if (employeeStatsChartInstance) {
        employeeStatsChartInstance.destroy(); // Destroy previous chart if exists
    }

    if (!rows || rows.length === 0) {
         // Optional: Display a message if no data
         ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); // Clear canvas
         ctx.font = "14px sans-serif";
         ctx.fillStyle = document.body.classList.contains('dark-mode') ? '#ccc' : '#666';
         ctx.textAlign = "center";
         ctx.fillText("No completion data found for the last 7 days.", ctx.canvas.width / 2, 50);
        document.getElementById('employeeStatsSpinner').style.display = 'none';
         return;
    }

    employeeStatsChartInstance = new Chart(ctx, {
        type: 'pie',
        data: {
            labels: rows.map(r => r.Employee ? r.Employee.name : 'Unknown Employee'),
            datasets: [{
                data: rows.map(r => r.count),
                 backgroundColor: [
                   'rgba(255, 99, 132, 0.7)',
                   'rgba(54, 162, 235, 0.7)',
                   'rgba(255, 206, 86, 0.7)',
                   'rgba(75, 192, 192, 0.7)',
                   'rgba(153, 102, 255, 0.7)',
                   'rgba(255, 159, 64, 0.7)',
                   'rgba(199, 199, 199, 0.7)',
                 ],
                 borderColor: document.body.classList.contains('dark-mode') ? '#2c2c2c' : '#fff',
                 borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top',
                     labels: {
                        color: document.body.classList.contains('dark-mode') ? '#e0e0e0' : '#333'
                    }
                },
                title: {
                    display: false
                }
            }
        }
    });
    document.getElementById('employeeStatsSpinner').style.display = 'none';
}

// --- NEW: Load Employee Stats ---
async function loadEmployeeStats() {
    const spinner = document.getElementById('employeeStatsSpinner');
    if(spinner) spinner.style.display = 'block';
    try {
        const res = await fetch('/api/user/stats/completions', {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) {
            throw new Error(`Failed to fetch stats: ${res.status}`);
        }
        const data = await res.json();
        lastEmployeeStatsData = data;
        renderEmployeePieChart(data);
    } catch (error) {
        console.error("Error loading employee stats:", error);
        const ctx = document.getElementById('employeeStatsChart')?.getContext('2d');
         if (ctx) {
             ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
             ctx.font = "14px sans-serif";
             ctx.fillStyle = '#dc3545';
             ctx.textAlign = "center";
             ctx.fillText("Could not load activity data.", ctx.canvas.width / 2, 50);
         }
        if(spinner) spinner.style.display = 'none';
    }
}

// --- NEW: Refresh Data ---
async function refreshData() {
    console.log("Refreshing tasks and stats...");
    const refreshButton = document.getElementById('refreshBtn');
    if (refreshButton) {
        refreshButton.disabled = true; // Disable button during refresh
        refreshButton.innerHTML = `
            <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
            Refreshing...`;
    }
    try {
        await loadTasks(); // Reloads categories and tasks for the selected category
        await loadEmployeeStats(); // Reloads the pie chart
        checkAndUpdateOverdueStatus(); // Re-check overdue status after refresh
        // Note: updateCheckoutButtonState() is called within loadTasks -> displayTasksForCategory
    } catch (error) {
        console.error("Error during refresh:", error);
        alert("Failed to refresh data. Please try again.");
    } finally {
        if (refreshButton) {
            refreshButton.disabled = false; // Re-enable button
            refreshButton.innerHTML = `
                <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\" fill=\"currentColor\" class=\"bi bi-arrow-clockwise\" viewBox=\"0 0 16 16\">\n                    <path fill-rule=\"evenodd\" d=\"M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2z\"/>\n                    <path d=\"M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466\"/>\n                </svg>\n                Refresh`;
        }
    }
}

// --- ADD THE NEW logout() FUNCTION ---
function logout() {
    stopOverdueChecker(); // Stop the interval timer
    // Reloading the page effectively logs the user out by clearing the token
    window.location.reload();
} 