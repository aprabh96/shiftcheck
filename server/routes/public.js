import express from 'express';
import { Employee } from '../models/Employee.js';
import { Op } from 'sequelize';

const router = express.Router();

// GET /api/employees/list -> Public list of employee names and IDs for login dropdown
router.get('/list', async (req, res) => {
    try {
        const employees = await Employee.findAll({
            attributes: ['id', 'name'], // Only fetch ID and name
            where: {
                role: { [Op.not]: 'admin' } // Exclude admin role
            },
            order: [['name', 'ASC']]     // Order alphabetically
        });
        res.json(employees);
    } catch (error) {
        console.error("Error fetching employee list for login:", error);
        res.status(500).json({ msg: 'Failed to retrieve employee list.' });
    }
});

// GET /api/employees/config -> what the sign-in pages need before anyone is signed in
router.get('/config', (req, res) => {
  res.json({ businessName: process.env.BUSINESS_NAME || 'ShiftCheck' });
});

export default router; 