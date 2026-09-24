import express from 'express';
import jwt from 'jsonwebtoken';
import { Employee } from '../models/Employee.js';
import { TaskLog } from '../models/index.js';
import { Op } from 'sequelize';

const router = express.Router();

// Auth middleware (same as in tasks.js)
function verifyToken(req, res, next) {
  const bearer = req.header('Authorization');
  const token = bearer?.split(' ')[1];
  if (!token) return res.status(401).json({ msg: 'No token' });

  try {
    // Attach user payload (id, role) to the request object
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ msg: 'Invalid token' });
  }
}

// Apply middleware to all routes in this file
router.use(verifyToken);

// PUT /api/user/theme - Update logged-in user's theme preference
router.put('/theme', async (req, res) => {
  const { theme } = req.body;
  const userId = req.user.id; // Get user ID from verified token

  // Validate input theme
  if (!['light', 'dark'].includes(theme)) {
    return res.status(400).json({ msg: 'Invalid theme value. Use "light" or "dark".' });
  }

  try {
    const employee = await Employee.findByPk(userId);
    if (!employee) {
      // Should not happen if token is valid, but good practice
      return res.status(404).json({ msg: 'Employee not found.' });
    }

    employee.theme_preference = theme;
    await employee.save();

    res.json({ msg: 'Theme preference updated successfully.' });

  } catch (error) {
    console.error('Error updating theme preference:', error);
    res.status(500).json({ msg: 'Failed to update theme preference.' });
  }
});

// GET /api/user/stats/completions -> completions by employee (last 7 days)
router.get('/stats/completions', async (req, res) => {
    try {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(endDate.getDate() - 7); // Last 7 days

        const rows = await TaskLog.findAll({
            where: {
                completed_at: {
                    [Op.gte]: startDate,
                    [Op.lt]: endDate // Use less than for the end date to include up to the current time
                }
            },
            attributes: [
                'employee_id',
                [TaskLog.sequelize.fn('COUNT', TaskLog.sequelize.col('TaskLog.id')), 'count']
            ],
            group: ['employee_id', 'Employee.id', 'Employee.name'], // Group by all non-aggregated fields in SELECT + included model
            include: [{
                model: Employee,
                attributes: ['id', 'name'] // Include employee name for the labels
            }],
            raw: false, // Set raw: false to get nested Employee object
            order: [[TaskLog.sequelize.fn('COUNT', TaskLog.sequelize.col('TaskLog.id')), 'DESC']] // Optional: order by count
        });

        res.json(rows);
    } catch (err) {
        console.error('User Stats/completions error:', err);
        res.status(500).json({ msg: 'Server error fetching completions stats' });
    }
});

export default router; 