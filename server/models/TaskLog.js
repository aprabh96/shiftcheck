import { DataTypes } from 'sequelize';
import { sequelize } from '../config/db.js';

export const TaskLog = sequelize.define(
  'TaskLog',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    task_id: { type: DataTypes.INTEGER, allowNull: false },
    employee_id: { type: DataTypes.INTEGER, allowNull: false },
    completed_at: { type: DataTypes.DATE, allowNull: false },
    ip: DataTypes.STRING(45),
    location: DataTypes.STRING(255),
    display_name: { type: DataTypes.STRING(100) }
  },
  { tableName: 'task_logs', underscored: true }
); 