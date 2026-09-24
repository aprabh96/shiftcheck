import express from 'express';
import jwt from 'jsonwebtoken';
import { Employee } from '../models/Employee.js';
import bcrypt from 'bcryptjs';
import { geoLookup } from '../utils/geo.js';

const DUMMY_HASH = bcrypt.hashSync('not-a-real-pin', 10);

const router = express.Router();

// --- helpers -------------------------------------------------
// req.ip honours X-Forwarded-For only when TRUST_PROXY=true (see server.js), so it cannot be faked.
function clientIp(req) {
  return (req.ip || '').replace('::ffff:', '');
}

// Slows PIN guessing from one address: 20 failed sign-ins per 15 minutes, across all accounts.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_IP = 20;
const failsByIp = new Map();
function tooManyFails(ip) {
  const now = Date.now();
  const entry = failsByIp.get(ip);
  if (!entry || now - entry.start > WINDOW_MS) return false;
  return entry.count >= MAX_FAILS_PER_IP;
}
function recordFail(ip) {
  const now = Date.now();
  const entry = failsByIp.get(ip);
  if (!entry || now - entry.start > WINDOW_MS) failsByIp.set(ip, { start: now, count: 1 });
  else entry.count += 1;
  if (failsByIp.size > 10000) failsByIp.clear();
}

// --- POST /api/auth/login  ----------------------------------
router.post('/login', async (req, res) => {
  let { employeeId, pin } = req.body;
  const MAX_LOGIN_ATTEMPTS = 10; // Define the limit

  if (!pin || typeof pin !== 'string') return res.status(400).json({ msg: 'PIN required' });
  const ip = clientIp(req);
  if (tooManyFails(ip)) return res.status(429).json({ msg: 'Too many failed sign-ins. Try again in 15 minutes.' });

  let employeeIdentifier = {};
  if (employeeId) {
    employeeIdentifier = { id: employeeId };
  } else {
    // If no employeeId supplied, try to find the 'admin' user
    employeeIdentifier = { role: 'admin' };
  }

  try {
    const emp = await Employee.findOne({ where: employeeIdentifier });

    if (!emp) {
      // User or Admin not found. Compare against a dummy hash so the response time doesn't reveal that.
      bcrypt.compareSync(pin, DUMMY_HASH);
      recordFail(ip);
      return res.status(401).json({ msg: 'Invalid credentials' });
    }

    // --- BEGIN ATTEMPT LIMIT LOGIC ---

    // 1. Check if account is already locked
    if (emp.is_locked) {
      console.warn(`Login attempt for locked account: ${emp.name} (ID: ${emp.id})`);
      return res.status(403).json({ msg: 'Account locked due to too many failed login attempts.' });
    }

    // 2. Verify the PIN
    const isPinValid = emp.verifyPin(pin);

    if (isPinValid) {
      // 3a. Successful Login: Reset attempts and unlock (if it was somehow locked)
      if (emp.failed_attempts > 0 || emp.is_locked) {
        emp.failed_attempts = 0;
        emp.is_locked = false;
        await emp.save(); // Save changes immediately
      }

      // --- Existing JWT and GeoIP Logic ---
      const token = jwt.sign(
        { id: emp.id, role: emp.role },
        process.env.JWT_SECRET,
        { expiresIn: '12h' }
      );

      const currentIp = ip;
      // Update IP/Location asynchronously - no need to wait for login response
      if (emp.last_login_ip !== currentIp) {
        geoLookup(currentIp).then(location => {
          emp.update({
            last_login_ip: currentIp,
            last_login_loc: location
          }).catch(err => console.error(`Error updating login info for ${emp.id}:`, err));
        }).catch(err => console.error(`GeoIP lookup failed for ${currentIp}:`, err));
      }
      // --- End Existing JWT and GeoIP Logic ---

      console.log(`Successful login for ${emp.name} (ID: ${emp.id})`);
      res.json({ token, name: emp.name, theme: emp.theme_preference });

    } else {
      // 3b. Failed Login: Increment attempts and potentially lock
      recordFail(ip);
      emp.failed_attempts += 1;
      console.warn(`Failed login attempt ${emp.failed_attempts}/${MAX_LOGIN_ATTEMPTS} for ${emp.name} (ID: ${emp.id})`);

      if (emp.failed_attempts >= MAX_LOGIN_ATTEMPTS) {
        emp.is_locked = true;
        console.error(`Account locked for ${emp.name} (ID: ${emp.id}) due to ${emp.failed_attempts} failed attempts.`);
      }

      await emp.save(); // Save the updated attempt count and lock status

      // Return a generic failure message regardless of lock status
      return res.status(401).json({ msg: 'Invalid credentials' });
    }
    // --- END ATTEMPT LIMIT LOGIC ---

  } catch (error) {
    console.error('Login process error:', error);
    res.status(500).json({ msg: 'Server error during login.' });
  }
});

export default router; 