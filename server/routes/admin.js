import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import {
  Employee,
  Task,
  TaskAssignment,
  TaskLog,
  Checkout,
  Comment,
  UserTaskRead,
  Category,
  CategoryAssignment
} from '../models/index.js';
import { Op } from 'sequelize';
import { Parser } from 'json2csv';
import PDFDocument from 'pdfkit';
import stream from 'stream';
import { sequelize } from '../config/db.js';

const router = express.Router();

// -------------------------------------------------------------
// auth middleware
// Admins can do everything here. Viewers can open the console and read (GET) but not change anything.
// The role is re-read from the database on every request, so demoting someone takes effect at once.
async function verifyStaff(req, res, next) {
  const token = req.header('Authorization')?.split(' ')[1];
  if (!token) return res.status(401).json({ msg: 'No token' });
  let data;
  try {
    data = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ msg: 'Invalid token' });
  }
  try {
    const emp = await Employee.findByPk(data.id);
    if (!emp || !['admin', 'viewer'].includes(emp.role)) return res.status(403).json({ msg: 'Forbidden' });
    if (emp.role === 'viewer' && req.method !== 'GET') return res.status(403).json({ msg: 'Viewers cannot make changes' });
    req.user = { id: emp.id, role: emp.role };
    next();
  } catch (err) {
    next(err);
  }
}

function verifyAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ msg: 'Forbidden' });
  next();
}

router.use(verifyStaff);

// -------------------------------------------------------------
// ----- Task Comments (Admin View/Add) ------------------------

// GET /api/admin/tasks/:taskId/comments -> Get comments for a specific task (Admin)
router.get('/tasks/:taskId(\\d+)/comments', async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ msg: 'Invalid Task ID' });
    }

    // Optional: Check if task exists
    const task = await Task.findByPk(taskId);
    if (!task) {
        return res.status(404).json({ msg: 'Task not found' });
    }

    const comments = await Comment.findAll({
      where: { task_id: taskId },
      include: [
        { model: Employee, attributes: ['id', 'name', 'role'] } // Include commenter details
      ],
      order: [['created_at', 'DESC']]
    });

    const formattedComments = comments.map(c => ({
        id: c.id,
        comment_text: c.comment_text,
        created_at: c.created_at?.toLocaleString('en-US', { timeZone: 'America/Chicago' }),
        Employee: c.Employee // Keep nested structure
    }));

    res.json(formattedComments);

  } catch (err) {
    console.error(`Admin: Error fetching comments for task ${req.params.taskId}:`, err);
    res.status(500).json({ msg: 'Server error fetching comments' });
  }
});

// POST /api/admin/tasks/:taskId/comments -> Add a comment to a task (Admin)
router.post('/tasks/:taskId(\\d+)/comments', verifyAdmin, async (req, res) => { // Ensure only Admin can post
  try {
    const taskId = parseInt(req.params.taskId, 10);
    const adminUserId = req.user.id; // Admin's employee ID from token
    const { commentText } = req.body;

    if (isNaN(taskId)) {
      return res.status(400).json({ msg: 'Invalid Task ID' });
    }
    if (!commentText || typeof commentText !== 'string' || commentText.trim().length === 0) {
      return res.status(400).json({ msg: 'Comment text is required' });
    }

    // Optional: Check if task exists
     const task = await Task.findByPk(taskId);
    if (!task) {
        return res.status(404).json({ msg: 'Task not found' });
    }

    const newComment = await Comment.create({
      task_id: taskId,
      employee_id: adminUserId, // Use admin's ID
      comment_text: commentText.trim()
    });

    // Fetch the created comment with employee details
    const commentWithAuthor = await Comment.findByPk(newComment.id, {
        include: [{ model: Employee, attributes: ['id', 'name', 'role'] }]
    });

    const formattedComment = {
        id: commentWithAuthor.id,
        comment_text: commentWithAuthor.comment_text,
        created_at: commentWithAuthor.created_at?.toLocaleString('en-US', { timeZone: 'America/Chicago' }),
        Employee: commentWithAuthor.Employee
    };

    res.status(201).json(formattedComment);

  } catch (err) {
    console.error(`Admin: Error adding comment for task ${req.params.taskId}:`, err);
    res.status(500).json({ msg: 'Server error adding comment' });
  }
});

// -------------------------------------------------------------
// ----- Employees CRUD ----------------------------------------
router.get('/employees', async (req, res) => {
  // Include is_locked in the result, exclude pin_hash
  const list = await Employee.findAll({ 
    attributes: { exclude: ['pin_hash'] },
    order: [['name', 'ASC']] // Optional: Add ordering
  });
  res.json(list);
});

// A whole positive number (or a string of digits); anything else becomes NaN and is rejected.
function toId(value) {
  return (Number.isInteger(value) && value > 0) || (typeof value === 'string' && /^\d{1,10}$/.test(value)) ? Number(value) : NaN;
}

const ROLES = ['employee', 'viewer', 'admin'];
const MIN_PIN = { employee: 4, viewer: 6, admin: 6 };
function pinProblem(pin, role) {
  const min = MIN_PIN[role] || 4;
  return /^\d+$/.test(String(pin)) && String(pin).length >= min ? null : `PIN must be at least ${min} digits for this role.`;
}
async function adminCount() {
  return Employee.count({ where: { role: 'admin' } });
}

router.post('/employees', verifyAdmin, async (req, res) => {
  const { name, pin, role = 'employee' } = req.body;
  if (typeof name !== 'string' || !name.trim() || name.length > 100 || !pin) return res.status(400).json({ msg: 'name (up to 100 characters) & pin required' });
  if (!ROLES.includes(role)) return res.status(400).json({ msg: 'role must be employee, viewer or admin' });
  const problem = pinProblem(pin, role);
  if (problem) return res.status(400).json({ msg: problem });

  const pin_hash = bcrypt.hashSync(String(pin), 10);
  const emp = await Employee.create({ name: name.trim(), pin_hash, role });
  res.json({ id: emp.id });
});

router.put('/employees/:id(\\d+)', verifyAdmin, async (req, res) => {
  const emp = await Employee.findByPk(req.params.id);
  if (!emp) return res.sendStatus(404);

  const { name, pin, role, theme_preference } = req.body;
  if (role && !ROLES.includes(role)) return res.status(400).json({ msg: 'role must be employee, viewer or admin' });
  if (role && role !== 'admin' && emp.role === 'admin' && (await adminCount()) <= 1) {
    return res.status(400).json({ msg: 'This is the only admin. Make someone else an admin first.' });
  }
  if (pin) {
    const problem = pinProblem(pin, role || emp.role);
    if (problem) return res.status(400).json({ msg: problem });
  }
  if (typeof name === 'string' && name.trim()) emp.name = name.trim().slice(0, 100);
  if (pin) emp.pin_hash = bcrypt.hashSync(String(pin), 10);
  if (role) emp.role = role;
  if (theme_preference && ['light', 'dark'].includes(theme_preference)) {
    emp.theme_preference = theme_preference;
  }
  await emp.save();
  res.json({ msg: 'updated' });
});

router.delete('/employees/:id(\\d+)', verifyAdmin, async (req, res) => {
  const emp = await Employee.findByPk(req.params.id);
  if (emp && emp.role === 'admin' && (await adminCount()) <= 1) {
    return res.status(400).json({ msg: 'This is the only admin and cannot be deleted.' });
  }
  await Employee.destroy({ where: { id: req.params.id } });
  res.sendStatus(204);
});

// PUT /api/admin/employees/:id/unlock
router.put('/employees/:id(\\d+)/unlock', verifyAdmin, async (req, res) => { // Ensure only admin can unlock
  try {
    const emp = await Employee.findByPk(req.params.id);
    if (!emp) {
      return res.status(404).json({ msg: 'Employee not found' });
    }

    emp.failed_attempts = 0;
    emp.is_locked = false;
    await emp.save();

    console.log(`Admin ${req.user.id} unlocked account for ${emp.name} (ID: ${emp.id})`);
    res.json({ msg: `Employee ${emp.name} unlocked successfully.` });

  } catch (error) {
    console.error(`Error unlocking employee ${req.params.id} by admin ${req.user.id}:`, error);
    res.status(500).json({ msg: 'Failed to unlock employee.' });
  }
});

// GET /api/admin/employees/:id/categories
router.get('/employees/:id(\\d+)/categories', async (req,res) => {
  const cats = await CategoryAssignment.findAll({
    where:{ employee_id: req.params.id },
    attributes:['category_id']
  });
  res.json(cats.map(c=>c.category_id));
});

// POST /api/admin/employees/:id/categories
router.post('/employees/:id(\\d+)/categories', async (req,res) => {
  const empId = parseInt(req.params.id,10);
  const { categoryIds } = req.body; // [1,4,5]
  const t = await sequelize.transaction();
  try {
    await CategoryAssignment.destroy({ where:{ employee_id: empId }, transaction:t });
    if (Array.isArray(categoryIds) && categoryIds.length) {
      await CategoryAssignment.bulkCreate(
        categoryIds.map(cid=>({ employee_id: empId, category_id: cid })),
        { transaction:t }
      );
    }
    await t.commit();
    res.json({ msg:'OK' });
  } catch(e){
    await t.rollback();
    res.status(500).json({ msg:'Failed' });
  }
});

// -------------------------------------------------------------
// ----- Task CRUD ---------------------------------------------
router.get('/tasks', async (req, res) => {
    const { employeeId, categoryId } = req.query;
    const adminUserId = req.user.id; // Get logged-in admin's ID
    const taskWhere = {};
    const employeeInclude = {
        model: Employee,
        attributes: ['id', 'name'],
        through: { attributes: [] },
        required: false
    };
    // --- Category Filter ---
    if (categoryId && categoryId !== 'all') {
        taskWhere.category_id = parseInt(categoryId, 10);
    }
    // --- Employee Filter ---
    if (employeeId) {
        let validEmployeeIds = [];
        if (Array.isArray(employeeId)) {
            validEmployeeIds = employeeId.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
        } else if (employeeId !== 'all') {
            const parsedId = parseInt(employeeId, 10);
            if (!isNaN(parsedId)) { validEmployeeIds.push(parsedId); }
        }
        if (validEmployeeIds.length > 0) {
            employeeInclude.where = { id: { [Op.in]: validEmployeeIds } };
            employeeInclude.required = true;
        }
    }
    try {
        // 1. Fetch filtered tasks (potentially based on employee/category)
        const filteredTasks = await Task.findAll({
            where: taskWhere,
            include: [employeeInclude, { model: Category, attributes: ['id', 'name', 'sort_order'] }],
            order: [
                [Category, 'sort_order', 'ASC'],
                ['sort_order', 'ASC'],
                ['title', 'ASC']
            ],
            distinct: true,
        });
        if (filteredTasks.length === 0) return res.json([]);
        const taskIds = filteredTasks.map(task => task.id);
        // 2. Fetch ALL assigned employees for the filtered tasks (for display)
        const tasksWithFullEmployees = await Task.findAll({
            where: { id: { [Op.in]: taskIds } },
            include: [{
                model: Employee,
                attributes: ['id', 'name'],
                through: { attributes: [] }
            }],
            order: [['title', 'ASC']],
        });
        const taskEmployeeMap = {};
        tasksWithFullEmployees.forEach(task => {
            taskEmployeeMap[task.id] = task.Employees.map(e => e.name).join(', ') || '<em class="text-muted">None</em>';
        });
        // 3. Fetch the LATEST log for each of these tasks
        const lastLogMap = {};
        const latestLogs = await TaskLog.findAll({
            where: { task_id: { [Op.in]: taskIds } },
            attributes: ['task_id', 'completed_at', 'display_name'],
            order: [['completed_at', 'DESC']]
        });
        for (const log of latestLogs) {
            if (!lastLogMap[log.task_id]) {
                lastLogMap[log.task_id] = {
                    when: new Date(log.completed_at),
                    who: log.display_name || 'Unknown'
                };
            }
        }
        // 4. Get latest comment timestamp for each task
        const latestComments = await Comment.findAll({
            where: { task_id: { [Op.in]: taskIds } },
            attributes: ['task_id', [Comment.sequelize.fn('MAX', Comment.sequelize.col('created_at')), 'latestCommentTime']],
            group: ['task_id'],
            raw: true
        });
        const latestCommentMap = Object.fromEntries(
            latestComments.map(c => [c.task_id, new Date(c.latestCommentTime)])
        );
        // 5. Get the ADMIN's last read timestamp for each task
        const adminReads = await UserTaskRead.findAll({
            where: { employee_id: adminUserId, task_id: { [Op.in]: taskIds } },
            attributes: ['task_id', 'last_read_at'],
            raw: true
        });
        const adminReadMap = Object.fromEntries(
            adminReads.map(r => [r.task_id, new Date(r.last_read_at)])
        );
        // 6. Enrich the tasks data
        const now = Date.now();
        const enrichedTasks = filteredTasks.map(taskInstance => {
            const task = taskInstance.toJSON();
            const last = lastLogMap[task.id];
            const hoursSince = last ? (now - last.when.getTime()) / 3.6e6 : Infinity;
            const isOverdue = task.no_timeout
                ? (hoursSince === Infinity) // If no_timeout=true, it's ONLY overdue if never completed (hoursSince is Infinity)
                : (hoursSince > task.tolerance_hours); // Otherwise (normal task), check tolerance
            const latestCommentTime = latestCommentMap[task.id];
            const lastReadTime = adminReadMap[task.id];
            let hasUnreadComments = false;
            if (latestCommentTime && (!lastReadTime || latestCommentTime > lastReadTime)) {
                hasUnreadComments = true;
            }
            return {
                id: task.id,
                title: task.title,
                description: task.description,
                tolerance_hours: task.tolerance_hours,
                Employees: task.Employees,
                assignedNames: taskEmployeeMap[task.id],
                last_done: last ? last.when.toLocaleString('en-US', { timeZone: 'America/Chicago' }) : 'Never',
                lastBy: last ? last.who : '-',
                overdue: isOverdue,
                hasUnreadComments: hasUnreadComments,
                no_timeout: task.no_timeout,
                categoryName: task.Category?.name,
                categoryId: task.Category?.id
            };
        });
        res.json(enrichedTasks);
    } catch (error) {
        console.error("Error fetching tasks for admin:", error);
        res.status(500).json({ msg: 'Failed to fetch tasks' });
    }
});

router.post('/tasks', async (req, res) => {
  const { title, description, category_id, tolerance_hours, no_timeout = false } = req.body;
  if (!title || !category_id) return res.status(400).json({ msg: 'title & category_id required' });

  try {
    // Find the current maximum sort_order WITHIN this category
    const maxOrder = await Task.max('sort_order', { where: { category_id: category_id } });
    const nextOrder = (typeof maxOrder === 'number') ? maxOrder + 1 : 0;

    const task = await Task.create({
      title,
      description,
      category_id,
      tolerance_hours,
      no_timeout,
      sort_order: nextOrder
    });
    res.json({ id: task.id });
  } catch (error) {
    console.error("Error creating task:", error);
    res.status(500).json({ msg: 'Failed to create task' });
  }
});

router.put('/tasks/:id(\\d+)', async (req, res) => {
    const task = await Task.findByPk(req.params.id);
    if (!task) return res.sendStatus(404);

    // Extract expected fields from the request body
    const { title, description, category_id, tolerance_hours, no_timeout } = req.body;

    // Log the received body for debugging
    console.log('Received Task Update Body:', req.body);

    // Update task fields explicitly if they are provided in the request
    if (title !== undefined) {
        task.title = title.trim();
    }
    if (description !== undefined) {
        task.description = description.trim(); // Assuming description can be empty string
    }
    if (category_id !== undefined) {
        const parsedCategoryId = parseInt(category_id, 10);
        if (isNaN(parsedCategoryId)) {
            return res.status(400).json({ msg: 'Invalid category_id format.' });
        }
        task.category_id = parsedCategoryId;
    }
    if (tolerance_hours !== undefined) {
        const parsedTolerance = parseInt(tolerance_hours, 10);
        if (isNaN(parsedTolerance) || parsedTolerance < 0) {
            return res.status(400).json({ msg: 'Invalid tolerance_hours format.' });
        }
        task.tolerance_hours = parsedTolerance;
    }
    // Explicitly handle the boolean 'no_timeout' field
    if (no_timeout !== undefined) {
        // Ensure it's saved as a proper boolean (true/false)
        task.no_timeout = Boolean(no_timeout);
    }

    try {
        await task.save();
        res.json({ msg: 'updated' });
    } catch (error) {
        // Log the specific error for debugging
        console.error(`Error updating task ${req.params.id}:`, error);
        res.status(500).json({ msg: 'Failed to update task.', error: error.message });
    }
});

router.delete('/tasks/:id(\\d+)', async (req, res) => {
  await Task.destroy({ where: { id: req.params.id } });
  res.sendStatus(204);
});

// -------------------------------------------------------------
// ----- Assign/Unassign tasks to employees --------------------
// GET /api/admin/tasks/:id/assignments -> list of employee IDs assigned to task
router.get('/tasks/:id(\\d+)/assignments', async (req, res) => {
  const taskId = req.params.id;
  try {
    const assignments = await TaskAssignment.findAll({
      where: { task_id: taskId },
      attributes: ['employee_id']
    });
    const employeeIds = assignments.map(a => a.employee_id);
    res.json(employeeIds);
  } catch (error) {
    console.error(`Error fetching assignments for task ${taskId}:`, error);
    res.status(500).json({ msg: 'Failed to fetch assignments' });
  }
});

// POST /api/admin/tasks/:id/set-assignments -> replace assignments for a task
router.post('/tasks/:id(\\d+)/set-assignments', async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const { employeeIds } = req.body; // Expecting an array of integers

  if (!Array.isArray(employeeIds)) {
    return res.status(400).json({ msg: 'employeeIds must be an array.' });
  }
  if (isNaN(taskId)) {
     return res.status(400).json({ msg: 'Invalid task ID.' });
  }

  const t = await sequelize.transaction(); // Start transaction

  try {
    // 1. Delete existing assignments for this task
    await TaskAssignment.destroy({
      where: { task_id: taskId },
      transaction: t
    });

    // 2. Create new assignments if any employees were selected
    if (employeeIds.length > 0) {
      const newAssignments = employeeIds.map(empId => ({
        task_id: taskId,
        employee_id: parseInt(empId, 10) // Ensure it's an integer
      }));
      await TaskAssignment.bulkCreate(newAssignments, { transaction: t });
    }

    // 3. Commit the transaction
    await t.commit();
    res.json({ msg: 'Assignments updated successfully' });

  } catch (error) {
    // 4. Rollback transaction on error
    await t.rollback();
    console.error(`Error setting assignments for task ${taskId}:`, error);
    res.status(500).json({ msg: 'Failed to update assignments' });
  }
});

// POST /api/admin/tasks/bulk-assign -> set assignments for multiple tasks
router.post('/tasks/bulk-assign', async (req, res) => {
    const { taskIds, employeeIds } = req.body; // Expecting arrays of integers

    // Basic validation
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
        return res.status(400).json({ msg: 'taskIds must be a non-empty array.' });
    }
    if (!Array.isArray(employeeIds)) {
        return res.status(400).json({ msg: 'employeeIds must be an array.' });
    }
     // Ensure IDs are integers
    const validTaskIds = taskIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
    const validEmployeeIds = employeeIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id));

     if (validTaskIds.length !== taskIds.length) {
         return res.status(400).json({ msg: 'Invalid data in taskIds array.' });
     }
     // It's okay if validEmployeeIds is empty (means unassign all)

    const t = await sequelize.transaction(); // Start transaction

    try {
         console.log(`Bulk assigning employees [${validEmployeeIds.join(',')}] to tasks [${validTaskIds.join(',')}]`);

        for (const taskId of validTaskIds) {
            // 1. Delete existing assignments for this task within the transaction
            await TaskAssignment.destroy({
                where: { task_id: taskId },
                transaction: t
            });

            // 2. Create new assignments if any employees were selected
            if (validEmployeeIds.length > 0) {
                const newAssignments = validEmployeeIds.map(empId => ({
                    task_id: taskId,
                    employee_id: empId
                }));
                 await TaskAssignment.bulkCreate(newAssignments, { transaction: t });
            }
             console.log(`-> Updated assignments for task ${taskId}`);
        }

        // 3. Commit the transaction
        await t.commit();
         console.log("Bulk assignment transaction committed.");
        res.json({ msg: 'Bulk assignments updated successfully' });

    } catch (error) {
        // 4. Rollback transaction on error
        await t.rollback();
        console.error(`Error during bulk assignment:`, error);
        res.status(500).json({ msg: 'Failed to update assignments during bulk operation' });
    }
});

// NEW Endpoint: Check category access for bulk operations
router.get('/bulk-check-category-access', async (req, res) => {
    const { taskIds: taskIdsQuery, employeeIds: employeeIdsQuery } = req.query;

    if (!taskIdsQuery || !employeeIdsQuery) {
        return res.status(400).json({ msg: 'taskIds and employeeIds query parameters are required.' });
    }

    const taskIds = taskIdsQuery.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
    const employeeIds = employeeIdsQuery.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));

    if (taskIds.length === 0 || employeeIds.length === 0) {
        return res.json({ employeesWithoutAccess: [] }); // Nothing to check
    }

    try {
        // 1. Find all unique category IDs associated with the selected tasks
        const tasks = await Task.findAll({
            where: { id: { [Op.in]: taskIds } },
            attributes: ['category_id'],
            group: ['category_id'],
            raw: true,
        });
        const relevantCategoryIds = tasks.map(t => t.category_id).filter(id => id); // Filter out null/0 if necessary

        if (relevantCategoryIds.length === 0) {
            return res.json({ employeesWithoutAccess: [] }); // No categories associated
        }

        // 2. Find existing category assignments for the selected employees and relevant categories
        const existingAssignments = await CategoryAssignment.findAll({
            where: {
                employee_id: { [Op.in]: employeeIds },
                category_id: { [Op.in]: relevantCategoryIds }
            },
            raw: true
        });

        // 3. Determine missing assignments
        const employeesMissingAccess = {}; // Store as { empId: [missingCatId1, missingCatId2] }

        for (const empId of employeeIds) {
            const assignedCatIds = new Set(
                existingAssignments.filter(a => a.employee_id === empId).map(a => a.category_id)
            );
            const missingCats = relevantCategoryIds.filter(catId => !assignedCatIds.has(catId));
            if (missingCats.length > 0) {
                employeesMissingAccess[empId] = missingCats;
            }
        }

        // 4. Format the response with names
        const employeesWithoutAccessResult = [];
        if (Object.keys(employeesMissingAccess).length > 0) {
            const missingEmpIds = Object.keys(employeesMissingAccess).map(id => parseInt(id, 10));
            const allMissingCatIds = [...new Set(Object.values(employeesMissingAccess).flat())];

            const [employees, categories] = await Promise.all([
                Employee.findAll({ where: { id: { [Op.in]: missingEmpIds } }, attributes: ['id', 'name'], raw: true }),
                Category.findAll({ where: { id: { [Op.in]: allMissingCatIds } }, attributes: ['id', 'name'], raw: true })
            ]);
            const employeeMap = new Map(employees.map(e => [e.id, e]));
            const categoryMap = new Map(categories.map(c => [c.id, c]));

            for (const empId in employeesMissingAccess) {
                employeesWithoutAccessResult.push({
                    employee: employeeMap.get(parseInt(empId, 10)),
                    missingCategories: employeesMissingAccess[empId].map(catId => categoryMap.get(catId))
                });
            }
        }
        res.json({ employeesWithoutAccess: employeesWithoutAccessResult });
    } catch (error) {
        console.error("Error checking bulk category access:", error);
        res.status(500).json({ msg: 'Failed to check employee category access.' });
    }
});

// NEW Endpoint: Grant category access AND bulk assign tasks
router.post('/bulk-assign-and-grant-category', async (req, res) => {
    const { taskIds, employeeIds } = req.body;

    if (!Array.isArray(taskIds) || taskIds.length === 0 || !Array.isArray(employeeIds)) {
        return res.status(400).json({ msg: 'taskIds and employeeIds arrays are required.' });
    }
    const validTaskIds = taskIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
    const validEmployeeIds = employeeIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id));

    if (validTaskIds.length !== taskIds.length || validEmployeeIds.length !== employeeIds.length) {
        return res.status(400).json({ msg: 'Invalid IDs provided.' });
    }

    const t = await sequelize.transaction();
    try {
        // 1. Find relevant category IDs
        const tasks = await Task.findAll({
            where: { id: { [Op.in]: validTaskIds } },
            attributes: ['category_id'], group: ['category_id'], raw: true, transaction: t
        });
        const relevantCategoryIds = tasks.map(t => t.category_id).filter(id => id);

        // 2. Grant category access (using findOrCreate)
        for (const empId of validEmployeeIds) {
            for (const catId of relevantCategoryIds) {
                await CategoryAssignment.findOrCreate({
                    where: { employee_id: empId, category_id: catId },
                    transaction: t
                });
            }
        }

        // 3. Perform Bulk Task Assignment (delete old, create new)
        await TaskAssignment.destroy({ where: { task_id: { [Op.in]: validTaskIds } }, transaction: t });
        if (validEmployeeIds.length > 0) {
            const newAssignments = validTaskIds.flatMap(taskId =>
                validEmployeeIds.map(empId => ({ task_id: taskId, employee_id: empId }))
            );
            await TaskAssignment.bulkCreate(newAssignments, { transaction: t });
        }

        await t.commit();
        res.json({ msg: 'Category access granted and tasks assigned successfully.' });
    } catch (error) {
        await t.rollback();
        console.error("Error during bulk grant and assign:", error);
        res.status(500).json({ msg: 'Failed to grant access and assign tasks.' });
    }
});

// GET /api/admin/logs → paginated, searchable logs
router.get('/logs', async (req, res) => {
  const page   = parseInt(req.query.page)  || 1;
  const limit  = parseInt(req.query.limit) || 25;
  const search = req.query.search || '';
  const where = search
    ? {
        [Op.or]: [
          { '$Employee.name$': { [Op.like]: `%${search}%` } },
          { '$Task.title$':    { [Op.like]: `%${search}%` } }
        ]
      }
    : {};
  const { count, rows } = await TaskLog.findAndCountAll({
    where,
    include: [
      { model: Employee, attributes: ['id','name'] },
      { model: Task,     attributes: ['id','title'] }
    ],
    order:[['completed_at','DESC']],
    limit, offset: (page-1)*limit
  });
  res.json({ total: count, page, pages: Math.ceil(count/limit), logs: rows });
});

// Export logs as CSV or PDF
router.get('/logs/export', async (req, res) => {
  const format = req.query.format || 'csv';
  const logs = await TaskLog.findAll({
    include: [
      { model: Employee, attributes: ['name'] },
      { model: Task,     attributes: ['title'] }
    ],
    order: [['completed_at','DESC']]
  });
  const rows = logs.map(l => ({
    ID:            l.id,
    Task:          l.Task.title,
    Employee:      l.Employee.name,
    CompletedAt:   l.completed_at.toLocaleString('en-US',{timeZone:'America/Chicago'}),
    IP:            l.ip,
    Location:      l.location
  }));
  if (format==='pdf') {
    if (rows.length > 5000) {
      return res.status(413).json({ msg: 'Too many rows for PDF export – narrow your filters.' });
    }
    try {
      const doc = new PDFDocument();
      res.setHeader('Content-Type','application/pdf');
      doc.text('Task Logs\n\n');
      rows.forEach(r=>doc.text(Object.values(r).join(' | ')));
      doc.pipe(res); doc.end();
    } catch(e) {
      res.status(500).end('PDF error');
    }
  } else {
    if(rows.length>10000) return res.status(413).json({msg:'Export too large – filter by date'});
    const csv = new Parser().parse(rows);
    res.setHeader('Content-Disposition','attachment; filename=logs.csv');
    res.setHeader('Content-Type','text/csv');
    res.send(csv);
  }
});

// GET /api/admin/checkouts → show each checkout (with signature, limit support)
router.get('/checkouts', async (req, res) => {
  const limit = parseInt(req.query.limit) || null;
  const list = await Checkout.findAll({
    include: [{ model: Employee, attributes: ['name'] }],
    order: [['checkout_at','DESC']],
    ...(limit ? { limit } : {})
  });
  // New version with JSON parsing and date formatting
  const formatted = list.map(c => {
      const checkoutData = c.toJSON(); // Get the raw object from Sequelize

      // Check if checklist_json exists and is a string, then parse it
      if (checkoutData.checklist_json && typeof checkoutData.checklist_json === 'string') {
          try {
              // Parse the string into an actual object
              checkoutData.checklist_json = JSON.parse(checkoutData.checklist_json);
          } catch (e) {
              // Log error if parsing fails, maybe keep original string or set null
              console.error(`Failed to parse checklist_json for checkout ID ${checkoutData.id}:`, checkoutData.checklist_json, e);
              // Optionally set to null or keep the malformed string:
              // checkoutData.checklist_json = null;
          }
      }

      // Format the date (using the potentially modified checkoutData)
      checkoutData.checkout_at = new Date(checkoutData.checkout_at).toLocaleString('en-US', { timeZone: 'America/Chicago' });

      return checkoutData; // Return the processed object
  });
  res.json(formatted);
});

// GET /api/admin/stats/completions → completions by employee in date range
router.get('/stats/completions', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) 
    return res.status(400).json({ msg: 'start and end required' });

  try {
    const rows = await TaskLog.findAll({
      where: {
        completed_at: {
          [Op.gte]: new Date(start),
          [Op.lt]: new Date(new Date(end).setDate(new Date(end).getDate() + 1))
        }
      },
      attributes: [
        'employee_id',
        [TaskLog.sequelize.fn('COUNT', TaskLog.sequelize.col('TaskLog.id')), 'count']
      ],
      group: ['employee_id', 'Employee.id', 'Employee.name'],
      include: [{ model: Employee, attributes: ['id','name'] }]
    });
    res.json(rows);
  } catch (err) {
    console.error('Stats/completions error:', err);
    res.status(500).json({ msg: 'Server error fetching completions stats' });
  }
});

// Overdue stats endpoint
router.get('/stats/overdue', async (req, res) => {
  try {
    const { start, end } = req.query;
    const rows = await sequelize.query(
      `
      SELECT e.name            AS name,
             COUNT(*)          AS count
      FROM   task_logs tl
      JOIN   tasks      t ON t.id  = tl.task_id
      JOIN   employees  e ON e.id  = tl.employee_id
      WHERE  tl.completed_at BETWEEN :start
                               AND DATE_ADD(:end, INTERVAL 1 DAY)
        AND  TIMESTAMPDIFF(HOUR, tl.completed_at, NOW()) > t.tolerance_hours
      GROUP  BY tl.employee_id, e.name
      `,
      { replacements: { start, end }, type: sequelize.QueryTypes.SELECT }
    );
    return res.json(rows);
  } catch (err) {
    console.error('Stats/overdue error:', err);
    res.status(500).json({ msg: 'Server error fetching overdue stats' });
  }
});

// Daily completions endpoint for heatmap/bar chart
router.get('/stats/daily', async (req,res)=>{
  const {start,end}=req.query;
  const rows = await TaskLog.findAll({
    where:{ completed_at:{[Op.between]:[new Date(start),new Date(end)]}},
    attributes:[
      [TaskLog.sequelize.fn('DATE', TaskLog.sequelize.col('completed_at')), 'day'],
      [TaskLog.sequelize.fn('COUNT','*'),'count']
    ],
    group:['day'],
    raw:true
  });
  res.json(rows);   // [{day:'2025-04-14',count:17}, …]
});

// POST /api/admin/tasks/:taskId/mark-read -> Mark comments as read for current admin
router.post('/tasks/:taskId(\\d+)/mark-read', async (req, res) => {
    try {
        const taskId = parseInt(req.params.taskId, 10);
        const adminUserId = req.user.id; // Admin's ID from token
        if (isNaN(taskId)) {
            return res.status(400).json({ msg: 'Invalid Task ID' });
        }
        await UserTaskRead.upsert({
            employee_id: adminUserId,
            task_id: taskId,
            last_read_at: new Date()
        });
        res.json({ msg: 'Comments marked as read for this task.' });
    } catch(err) {
        console.error(`Admin: Error marking task ${req.params.taskId} read for admin ${req.user.id}:`, err);
        res.status(500).json({ msg: 'Server error marking comments as read.' });
    }
});

// --- list all categories for the UI ---
router.get('/categories', async (req, res) => {
  const cats = await Category.findAll({ 
    attributes: ['id', 'name', 'sort_order'],
    order: [['sort_order', 'ASC'], ['name', 'ASC']]
  });
  res.json(cats);
});

// POST /api/admin/categories
router.post('/categories', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ msg: 'name required' });

  try {
    // Find the current maximum sort_order
    const maxOrder = await Category.max('sort_order');
    const nextOrder = (typeof maxOrder === 'number') ? maxOrder + 1 : 0;

    const cat = await Category.create({ name, sort_order: nextOrder });
    res.json(cat);
  } catch (error) {
    console.error("Error creating category:", error);
    res.status(500).json({ msg: 'Failed to create category' });
  }
});

// -------------------------------------------------------------
// ----- Category Reordering (must come BEFORE the :id route) ---
router.put('/categories/reorder', async (req, res) => {
  const orderedIds = Array.isArray(req.body.orderedIds) ? req.body.orderedIds.map(toId) : null;
  if (!orderedIds || orderedIds.some((id) => !Number.isInteger(id) || id < 1)) {
    return res.status(400).json({ msg: 'orderedIds must be a list of category numbers.' });
  }

  const t = await sequelize.transaction();
  try {
    for (const [index, id] of orderedIds.entries()) {
      await Category.update({ sort_order: index }, { where: { id }, transaction: t });
    }

    await t.commit();
    res.json({ msg: 'Categories reordered successfully.' });
  } catch (error) {
    await t.rollback();
    console.error("Error reordering categories:", error);
    res.status(500).json({ msg: 'Failed to reorder categories.' });
  }
});

// PUT /api/admin/categories/:id
router.put('/categories/:id(\\d+)', async (req, res) => {
  const cat = await Category.findByPk(req.params.id);
  if (!cat) return res.sendStatus(404);
  cat.name = req.body.name || cat.name;
  await cat.save();
  res.json(cat);
});

// DELETE /api/admin/categories/:id
router.delete('/categories/:id(\\d+)', async (req, res) => {
  await Category.destroy({ where: { id: req.params.id } });
  res.sendStatus(204);
});

// Check which employees lack access to a category
router.get('/categories/:categoryId(\\d+)/check-employee-access', verifyAdmin, async (req, res) => {
    const categoryId = parseInt(req.params.categoryId, 10);
    const employeeIdQuery = req.query.employeeIds;

    if (isNaN(categoryId)) {
        return res.status(400).json({ msg: 'Invalid Category ID.' });
    }
    if (!employeeIdQuery) {
        return res.json({ employeesWithoutAccess: [] });
    }

    const employeeIds = employeeIdQuery.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
    if (employeeIds.length === 0) {
        return res.json({ employeesWithoutAccess: [] });
    }

    try {
        const assignments = await CategoryAssignment.findAll({
            where: {
                category_id: categoryId,
                employee_id: { [Op.in]: employeeIds }
            },
            attributes: ['employee_id']
        });
        const assignedEmployeeIds = new Set(assignments.map(a => a.employee_id));
        const employeesWithoutAccessIds = employeeIds.filter(id => !assignedEmployeeIds.has(id));
        let employeesWithoutAccess = [];
        if (employeesWithoutAccessIds.length > 0) {
            const employees = await Employee.findAll({
                where: { id: { [Op.in]: employeesWithoutAccessIds } },
                attributes: ['id', 'name']
            });
            employeesWithoutAccess = employees.map(e => ({ id: e.id, name: e.name }));
        }
        res.json({ employeesWithoutAccess });
    } catch (error) {
        console.error(`Error checking category access for category ${categoryId}:`, error);
        res.status(500).json({ msg: 'Failed to check employee category access.' });
    }
});

// Assign task to employees AND grant them access to the task's category
router.post('/tasks/:taskId(\\d+)/assign-and-grant-category', verifyAdmin, async (req, res) => {
    const taskId = parseInt(req.params.taskId, 10);
    const { employeeIds, categoryId } = req.body;

    if (isNaN(taskId) || isNaN(categoryId)) {
        return res.status(400).json({ msg: 'Invalid Task or Category ID.' });
    }
    if (!Array.isArray(employeeIds)) {
        return res.status(400).json({ msg: 'employeeIds must be an array.' });
    }
    const validEmployeeIds = employeeIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
    const t = await sequelize.transaction();
    try {
        if (validEmployeeIds.length > 0) {
            const categoryAssignments = validEmployeeIds.map(empId => ({
                category_id: categoryId,
                employee_id: empId
            }));
            for (const assignment of categoryAssignments) {
                await CategoryAssignment.findOrCreate({
                    where: { category_id: assignment.category_id, employee_id: assignment.employee_id },
                    defaults: assignment,
                    transaction: t
                });
            }
        }
        await TaskAssignment.destroy({
            where: { task_id: taskId },
            transaction: t
        });
        if (validEmployeeIds.length > 0) {
            const newTaskAssignments = validEmployeeIds.map(empId => ({
                task_id: taskId,
                employee_id: empId
            }));
            await TaskAssignment.bulkCreate(newTaskAssignments, { transaction: t });
        }
        await t.commit();
        res.json({ msg: 'Category access granted and task assignments updated successfully' });
    } catch (error) {
        await t.rollback();
        console.error(`Error in assign-and-grant for task ${taskId}:`, error);
        res.status(500).json({ msg: 'Failed to grant access and update assignments.' });
    }
});

// -------------------------------------------------------------
// ----- Task Reordering ---------------------------------------
router.put('/categories/:categoryId(\\d+)/tasks/reorder', async (req, res) => {
  const categoryId = parseInt(req.params.categoryId, 10);
  const { orderedIds } = req.body; // Expecting an array of TASK IDs [12, 10, 15]

  if (isNaN(categoryId)) {
    return res.status(400).json({ msg: 'Invalid category ID.' });
  }
  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ msg: 'orderedIds must be an array of task IDs.' });
  }

  const t = await sequelize.transaction();
  try {
    for (let i = 0; i < orderedIds.length; i++) {
      const taskId = orderedIds[i];
      // Ensure the task belongs to the category for safety
      await Task.update(
        { sort_order: i },
        { where: { id: taskId, category_id: categoryId }, transaction: t }
      );
    }
    await t.commit();
    res.json({ msg: 'Tasks reordered successfully within the category.' });
  } catch (error) {
    await t.rollback();
    console.error(`Error reordering tasks for category ${categoryId}:`, error);
    res.status(500).json({ msg: 'Failed to reorder tasks.' });
  }
});

export default router; 