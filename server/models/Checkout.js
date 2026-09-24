import { DataTypes } from 'sequelize';
import { sequelize } from '../config/db.js';

export const Checkout = sequelize.define(
  'Checkout',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    employee_id: { type: DataTypes.INTEGER, allowNull: false },
    checkout_at: { type: DataTypes.DATE, allowNull: false },
    ip: DataTypes.STRING(45),
    location: DataTypes.STRING(255),
    checklist_json: DataTypes.JSON
  },
  { tableName: 'checkouts', underscored: true }
); 