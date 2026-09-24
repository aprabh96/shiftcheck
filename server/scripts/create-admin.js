// Creates the first admin, or resets the PIN and unlocks an existing admin.
//
//   npm run create-admin -- --name "Owner"          (asks for the PIN, input hidden)
//   ADMIN_PIN=... npm run create-admin -- --name "Owner"
//
// Run it on the server itself; it is the way back in if the admin account ever gets locked.
import readline from 'readline';
import bcrypt from 'bcryptjs';
import { sequelize } from '../config/db.js';
import { Employee } from '../models/index.js';

const MIN_ADMIN_PIN = 6;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.stdoutMuted = true;
    rl._writeToOutput = (s) => { if (!rl.stdoutMuted || s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

const name = (arg('name') || 'Admin').trim();
let pin = process.env.ADMIN_PIN;
if (!pin) pin = await askHidden(`PIN for admin "${name}" (${MIN_ADMIN_PIN}+ digits): `);
pin = String(pin).trim();
if (!/^\d+$/.test(pin) || pin.length < MIN_ADMIN_PIN) {
  console.error(`The admin PIN must be at least ${MIN_ADMIN_PIN} digits.`);
  process.exit(1);
}

await sequelize.sync();
const pin_hash = bcrypt.hashSync(pin, 10);
const existing = await Employee.findOne({ where: { name, role: 'admin' } });
if (existing) {
  existing.pin_hash = pin_hash;
  existing.failed_attempts = 0;
  existing.is_locked = false;
  await existing.save();
  console.log(`Admin "${name}" updated: new PIN set and account unlocked.`);
} else {
  await Employee.create({ name, pin_hash, role: 'admin' });
  console.log(`Admin "${name}" created. Sign in at /admin.html`);
}
await sequelize.close();
