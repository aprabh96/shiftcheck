import { DataTypes } from 'sequelize';
import bcrypt from 'bcryptjs';
import { sequelize } from '../config/db.js';

export const Employee = sequelize.define(
  'Employee',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING(100), allowNull: false },
    pin_hash: { type: DataTypes.CHAR(60), allowNull: false },
    role: {
      type: DataTypes.ENUM('employee', 'admin', 'viewer'),
      defaultValue: 'employee'
    },
    last_login_ip:   { type: DataTypes.STRING(45), allowNull: true },
    last_login_loc:  { type: DataTypes.STRING(255), allowNull: true },
    theme_preference: {
      type: DataTypes.ENUM('light', 'dark'),
      allowNull: false,
      defaultValue: 'light'
    },
    failed_attempts: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    },
    is_locked: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
  },
  { tableName: 'employees', underscored: true }
);

// helper to verify plain‑text PIN
Employee.prototype.verifyPin = function (pin) {
  return bcrypt.compareSync(pin, this.pin_hash);
}; 