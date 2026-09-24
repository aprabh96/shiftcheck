import { Employee } from './Employee.js';
import { Task } from './Task.js';
import { TaskAssignment } from './TaskAssignment.js';
import { TaskLog } from './TaskLog.js';
import { Checkout } from './Checkout.js';
import { Comment } from './Comment.js';
import { UserTaskRead } from './UserTaskRead.js';
import { Category } from './Category.js';
import { CategoryAssignment } from './CategoryAssignment.js';

// many‑to‑many Employee ⇄ Task via TaskAssignment
Employee.belongsToMany(Task, {
  through: TaskAssignment,
  foreignKey: 'employee_id'
});
Task.belongsToMany(Employee, {
  through: TaskAssignment,
  foreignKey: 'task_id'
});

// relations for logs
TaskLog.belongsTo(Employee, { foreignKey: 'employee_id' });
TaskLog.belongsTo(Task, { foreignKey: 'task_id' });

Checkout.belongsTo(Employee, { foreignKey: 'employee_id' });

// Define relationships for Comment
Comment.belongsTo(Employee, { foreignKey: 'employee_id' });
Comment.belongsTo(Task, { foreignKey: 'task_id' });
Task.hasMany(Comment, { foreignKey: 'task_id' });
Employee.hasMany(Comment, { foreignKey: 'employee_id' });

// Define relationships for UserTaskRead
UserTaskRead.belongsTo(Employee, { foreignKey: 'employee_id' });
UserTaskRead.belongsTo(Task, { foreignKey: 'task_id' });
Employee.hasMany(UserTaskRead, { foreignKey: 'employee_id' });
Task.hasMany(UserTaskRead, { foreignKey: 'task_id' });

// Task ↔ Category
Category.hasMany(Task,          { foreignKey:'category_id' });
Task.belongsTo(Category,        { foreignKey:'category_id' });

// Employee ᠎↔ Category (for "ownership" of a category if you need it)
Category.belongsToMany(Employee,{ through:CategoryAssignment, foreignKey:'category_id' });
Employee.belongsToMany(Category,{ through:CategoryAssignment, foreignKey:'employee_id' });

export { Category, CategoryAssignment, Employee, Task, TaskAssignment, TaskLog, Checkout, Comment, UserTaskRead }; 