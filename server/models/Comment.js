import { DataTypes } from 'sequelize';
import { sequelize } from '../config/db.js';

export const Comment = sequelize.define(
  'Comment',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    task_id: { type: DataTypes.INTEGER, allowNull: false },
    employee_id: { type: DataTypes.INTEGER, allowNull: false },
    comment_text: { type: DataTypes.TEXT, allowNull: false },
    created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    },
  },
  {
    tableName: 'comments',
    underscored: true,
    timestamps: false
  }
); 