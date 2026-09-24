import { DataTypes } from 'sequelize';
import { sequelize } from '../config/db.js';

export const TaskAssignment = sequelize.define(
  'TaskAssignment',
  {
    employee_id: {
      type: DataTypes.INTEGER,
      primaryKey: true
    },
    task_id: {
      type: DataTypes.INTEGER,
      primaryKey: true
    }
  },
  { tableName: 'task_assignments', underscored: true, timestamps: false }
); 