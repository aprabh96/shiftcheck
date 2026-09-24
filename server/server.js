import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
dotenv.config();

import { sequelize } from './config/db.js';
import authRoutes from './routes/auth.js';
import taskRoutes from './routes/tasks.js';
import adminRoutes from './routes/admin.js';
import userRoutes from './routes/user.js';
import publicRoutes from './routes/public.js';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be set to 32+ random characters in server/.env (see .env.example).');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
// Only trust X-Forwarded-For when a reverse proxy in front of us sets it; otherwise anyone could fake their IP.
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
// The admin console and the employee page are served by this same server, so CORS is off unless configured.
if (process.env.CORS_ORIGIN) app.use(cors({ origin: process.env.CORS_ORIGIN.split(',').map((o) => o.trim()) }));
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  });
  next();
});

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/user', userRoutes);
app.use('/api/employees', publicRoutes);

// serve static client files
app.use(express.static(join(__dirname, '../client')));

// Last-resort error handler: log the details, never send them to the browser.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`Unhandled error on ${req.method} ${req.path}:`, err);
  if (!res.headersSent) res.status(500).json({ msg: 'Server error' });
});

process.on('unhandledRejection', (err) => console.error('Unhandled promise rejection:', err));

sequelize.sync().then(() => {
  const port = process.env.PORT || 3001;
  app.listen(port, () => console.log(`ShiftCheck running on http://localhost:${port}`));
}).catch((err) => {
  console.error('Could not connect to the database. Check DB_* in server/.env.', err.message);
  process.exit(1);
});
