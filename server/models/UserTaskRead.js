import { DataTypes } from 'sequelize';
import { sequelize } from '../config/db.js';

export const UserTaskRead = sequelize.define(
  'UserTaskRead',
  {
    employee_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true // Part of composite key
    },
    task_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true // Part of composite key
    },
    last_read_at: {
      type: DataTypes.DATE,
      allowNull: false
    },
  },
  {
    tableName: 'user_task_reads',
    underscored: true,
    timestamps: false // No default created_at/updated_at needed
  }
); 