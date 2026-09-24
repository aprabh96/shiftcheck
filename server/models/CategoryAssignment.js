import { DataTypes } from 'sequelize';
import { sequelize } from '../config/db.js';

export const CategoryAssignment = sequelize.define('CategoryAssignment',{
  category_id : { type:DataTypes.INTEGER.UNSIGNED, primaryKey:true },
  employee_id : { type:DataTypes.INTEGER.UNSIGNED, primaryKey:true }
},{ tableName:'category_assignments', underscored:true, timestamps:false }); 