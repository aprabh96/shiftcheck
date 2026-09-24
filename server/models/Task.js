import { DataTypes } from 'sequelize';
import { sequelize } from '../config/db.js';

export const Task = sequelize.define(
  'Task',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    title: { type: DataTypes.STRING(255), allowNull: false },
    description: DataTypes.TEXT,
    category_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    tolerance_hours: { type: DataTypes.INTEGER, defaultValue: 24 }, // > turns red
    no_timeout: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sort_order: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }
  },
  { tableName: 'tasks', underscored: true }
); 