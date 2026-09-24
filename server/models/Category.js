import { DataTypes } from 'sequelize';
import { sequelize } from '../config/db.js';

export const Category = sequelize.define('Category',{
  id  : { type:DataTypes.INTEGER.UNSIGNED, autoIncrement:true, primaryKey:true },
  name: { type:DataTypes.STRING(50), allowNull:false, unique:true },
  sort_order: { type:DataTypes.INTEGER.UNSIGNED, allowNull:false, defaultValue:0 }
},{ tableName:'categories', underscored:true, timestamps:false }); 