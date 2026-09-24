import express from 'express';
import jwt from 'jsonwebtoken';
import { Op } from 'sequelize';
import { Task, TaskLog, Employee, Checkout, Comment, UserTaskRead, Category, CategoryAssignment } from '../models/index.js';
import { geoLookup } from '../utils/geo.js';

const router = express.Router();

// -------------------------------------------------------------
// auth middleware
function verifyToken(req, res, next) {
  const bearer = req.header('Authorization');
  const token = bearer?.split(' ')[1];
  if (!token) return res.status(401).json({ msg: 'No token' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ msg: 'Invalid token' });
  }
}
router.use(verifyToken);

// Tasks this employee may see and act on: assigned to them AND in one of their categories
// (the same rule GET /api/tasks uses to build their list).
async function allowedTaskIds(empId) {
  const cats = await CategoryAssignment.findAll({ where: { employee_id: empId }, attributes: ['category_id'] });
  const categoryIds = cats.map((c) => c.category_id);
  if (categoryIds.length === 0) return new Set();
  const tasks = await Task.findAll({
    where: { category_id: { [Op.in]: categoryIds } },
    include: [{ model: Employee, where: { id: empId }, attributes: [] }],
    attributes: ['id'],
  });
  return new Set(tasks.map((t) => t.id));
}

// Every /:taskId route (comments, mark-read) is limited to the caller's own tasks.
router.param('taskId', async (req, res, next, value) => {
  try {
    const taskId = parseInt(value, 10);
    if (!(await allowedTaskIds(req.user.id)).has(taskId)) return res.status(404).json({ msg: 'Task not found' });
    next();
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// GET /api/tasks   → list tasks assigned to this employee
router.get('/', async (req, res) => {
  try {
    const empId = req.user.id;
    // 1. Get category assignments for this employee
    const catAssignments = await CategoryAssignment.findAll({
      where: { employee_id: empId },
      attributes: ['category_id']
    });
    const userCategoryIds = catAssignments.map(ca => ca.category_id);
    if (userCategoryIds.length === 0) {
      return res.json([]); // No categories assigned, no tasks
    }
    // 2. Get tasks assigned to the employee and in their categories
    const assignedTasks = await Task.findAll({
      where: { category_id: { [Op.in]: userCategoryIds } },
      include: [
        {
          model: Employee,
          where: { id: empId },
          attributes: []
        },
        { 
          model: Category, 
          attributes: ['id', 'name', 'sort_order'] 
        }
      ],
      order: [
        [Category, 'sort_order', 'ASC'],
        ['sort_order', 'ASC'],
        ['title', 'ASC']
      ]
    });
    if (assignedTasks.length === 0) {
      return res.json([]);
    }
    const taskIds = assignedTasks.map(t => t.id);
    // 3. Get the latest completion log for each task (existing logic)
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
    // 4. Get the latest comment timestamp for each task
    const latestComments = await Comment.findAll({
      where: { task_id: { [Op.in]: taskIds } },
      attributes: [
        'task_id',
        [Comment.sequelize.fn('MAX', Comment.sequelize.col('created_at')), 'latestCommentTime']
      ],
      group: ['task_id'],
      raw: true
    });
    const latestCommentMap = Object.fromEntries(
      latestComments.map(c => [c.task_id, new Date(c.latestCommentTime)])
    );
    // 5. Get the user's last read timestamp for each task
    const userReads = await UserTaskRead.findAll({
      where: { employee_id: empId, task_id: { [Op.in]: taskIds } },
      attributes: ['task_id', 'last_read_at'],
      raw: true
    });
    const userReadMap = Object.fromEntries(
      userReads.map(r => [r.task_id, new Date(r.last_read_at)])
    );
    // 6. Enrich tasks with all information
    const now = Date.now();
    const enrichedTasks = assignedTasks.map(taskInstance => {
      const task = taskInstance.toJSON();
      const lastLog = lastLogMap[task.id];
      const latestCommentTime = latestCommentMap[task.id];
      const lastReadTime = userReadMap[task.id];
      const hoursSince = lastLog ? (now - lastLog.when.getTime()) / 3.6e6 : Infinity;
      const isOverdue = task.no_timeout
        ? (hoursSince === Infinity) // If no_timeout=true, it's ONLY overdue if never completed (hoursSince is Infinity)
        : (hoursSince > task.tolerance_hours); // Otherwise (normal task), check tolerance
      // Determine if there are unread comments
      let hasUnreadComments = false;
      if (latestCommentTime) { // Only if there are comments
         if (!lastReadTime || latestCommentTime > lastReadTime) {
              hasUnreadComments = true;
         }
      }
      const completed_within_tolerance = !!lastLog && !isOverdue; // True if logged and not overdue
      return {
        id: task.id,
        title: task.title,
        description: task.description,
        categoryName: task.Category?.name,
        categoryId: task.Category?.id,
        categorySortOrder: task.Category?.sort_order,
        sort_order: task.sort_order,
        last_done: lastLog ? lastLog.when.toLocaleString('en-US', { timeZone: 'America/Chicago' }) : 'Never',
        last_done_timestamp: lastLog ? lastLog.when.toISOString() : null,
        lastBy: lastLog?.who || '-',
        overdue: isOverdue,
        hasUnreadComments: hasUnreadComments,
        no_timeout: task.no_timeout,
        tolerance_hours: task.tolerance_hours,
        completed_within_tolerance: completed_within_tolerance
      };
    });
    res.json(enrichedTasks);
  } catch (err) {
    console.error('Error in GET /api/tasks:', err);
    return res.status(500).json({ msg: 'Server error' });
  }
});

// -------------------------------------------------------------
// POST /api/tasks/complete   { taskIds:[], displayName }
// records logs & (optionally) checkout
router.post('/complete', async (req, res) => {
  const { displayName } = req.body;
  const empId = req.user.id;
  const taskIds = Array.isArray(req.body.taskIds) ? [...new Set(req.body.taskIds.map((id) => ((Number.isInteger(id) && id > 0) || (typeof id === 'string' && /^\d{1,10}$/.test(id)) ? Number(id) : NaN)))] : [];
  if (taskIds.length === 0 || taskIds.some((id) => !Number.isInteger(id)) || typeof displayName !== 'string' || !displayName.trim() || displayName.length > 100)
    return res.status(400).json({ msg: 'taskIds (list of task numbers) and displayName (up to 100 characters) required' });
  try {
    const allowed = await allowedTaskIds(empId);
    if (taskIds.some((id) => !allowed.has(id))) {
      return res.status(403).json({ msg: 'You can only complete tasks assigned to you.' });
    }
    // --- BEGIN UNREAD CHECK ---
    const tasksToCheck = await Task.findAll({
      where: { id: { [Op.in]: taskIds } },
      attributes: ['id', 'title']
    });
    if (tasksToCheck.length !== taskIds.length) {
      console.warn(`Checkout attempt for non-existent tasks. Requested: ${taskIds}, Found: ${tasksToCheck.map(t=>t.id)}`);
      return res.status(400).json({ msg: 'One or more tasks submitted do not exist.' });
    }
    const latestComments = await Comment.findAll({
      where: { task_id: { [Op.in]: taskIds } },
      attributes: ['task_id', [Comment.sequelize.fn('MAX', Comment.sequelize.col('created_at')), 'latestCommentTime']],
      group: ['task_id'],
      raw: true
    });
    const latestCommentMap = Object.fromEntries(latestComments.map(c => [c.task_id, new Date(c.latestCommentTime)]));
    const userReads = await UserTaskRead.findAll({
      where: { employee_id: empId, task_id: { [Op.in]: taskIds } },
      attributes: ['task_id', 'last_read_at'],
      raw: true
    });
    const userReadMap = Object.fromEntries(userReads.map(r => [r.task_id, new Date(r.last_read_at)]));
    const unreadTasks = [];
    for (const task of tasksToCheck) {
      const latestCommentTime = latestCommentMap[task.id];
      const lastReadTime = userReadMap[task.id];
      if (latestCommentTime && (!lastReadTime || latestCommentTime > lastReadTime)) {
        unreadTasks.push(task.title);
      }
    }
    if (unreadTasks.length > 0) {
      return res.status(400).json({
        msg: `Please review new comments before checking out the following task(s): ${unreadTasks.join(', ')}`
      });
    }
    // --- END UNREAD CHECK ---
    // --- Existing Logic (IP, Location, Log/Checkout Creation) ---
    const ip = (req.ip || '').replace('::ffff:', '');
    const loc = await geoLookup(ip);
    const logs = taskIds.map(id => ({
      task_id: id,
      employee_id: empId,
      completed_at: new Date(),
      display_name: displayName,
      ip,
      location: loc
    }));
    await TaskLog.bulkCreate(logs);
    await Checkout.create({
      employee_id: empId,
      checkout_at: new Date(),
      ip,
      location: loc,
      checklist_json: { displayName, taskIds }
    });
    res.json({ msg: 'logged', count: logs.length });
  } catch(err) {
    console.error(`Error during task completion for user ${empId}:`, err);
    res.status(500).json({ msg: 'Server error during checkout process.' });
  }
});

// -------------------------------------------------------------
// GET /api/tasks/:taskId/comments -> Get comments for a task
router.get('/:taskId(\\d+)/comments', async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ msg: 'Invalid Task ID' });
    }

    const comments = await Comment.findAll({
      where: { task_id: taskId },
      include: [
        { model: Employee, attributes: ['id', 'name'] }
      ],
      order: [['created_at', 'DESC']]
    });

    const formattedComments = comments.map(c => ({
        id: c.id,
        comment_text: c.comment_text,
        created_at: c.created_at?.toLocaleString('en-US', { timeZone: 'America/Chicago' }),
        Employee: c.Employee
    }));

    res.json(formattedComments);

  } catch (err) {
    console.error(`Error fetching comments for task ${req.params.taskId}:`, err);
    res.status(500).json({ msg: 'Server error fetching comments' });
  }
});

// -------------------------------------------------------------
// POST /api/tasks/:taskId/comments -> Add a comment to a task
router.post('/:taskId(\\d+)/comments', async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId, 10);
    const employeeId = req.user.id;
    const { commentText } = req.body;

    if (isNaN(taskId)) {
      return res.status(400).json({ msg: 'Invalid Task ID' });
    }
    if (!commentText || typeof commentText !== 'string' || commentText.trim().length === 0) {
      return res.status(400).json({ msg: 'Comment text is required' });
    }

    const newComment = await Comment.create({
      task_id: taskId,
      employee_id: employeeId,
      comment_text: commentText.trim()
    });

    const commentWithAuthor = await Comment.findByPk(newComment.id, {
        include: [{ model: Employee, attributes: ['id', 'name'] }]
    });

    const formattedComment = {
        id: commentWithAuthor.id,
        comment_text: commentWithAuthor.comment_text,
        created_at: commentWithAuthor.created_at?.toLocaleString('en-US', { timeZone: 'America/Chicago' }),
        Employee: commentWithAuthor.Employee
    };

    res.status(201).json(formattedComment);

  } catch (err) {
    console.error(`Error adding comment for task ${req.params.taskId}:`, err);
    res.status(500).json({ msg: 'Server error adding comment' });
  }
});

// POST /api/tasks/:taskId/mark-read -> Mark comments as read for current user
router.post('/:taskId(\\d+)/mark-read', async (req, res) => {
    try {
        const taskId = parseInt(req.params.taskId, 10);
        const employeeId = req.user.id;
        if (isNaN(taskId)) {
            return res.status(400).json({ msg: 'Invalid Task ID' });
        }
        await UserTaskRead.upsert({
            employee_id: employeeId,
            task_id: taskId,
            last_read_at: new Date()
        });
        res.json({ msg: 'Comments marked as read for this task.' });
    } catch(err) {
        console.error(`Error marking task ${req.params.taskId} read for user ${req.user.id}:`, err);
        res.status(500).json({ msg: 'Server error marking comments as read.' });
    }
});

export default router; 