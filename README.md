# ShiftCheck

**Free, self-hosted task checklists for small teams.** A manager sets up the checklists (opening,
closing, daily cleaning, whatever the business needs), staff sign in with a PIN on a shared tablet or
their phone and tick off what they did, and everyone can see how the team is doing.

It is a free alternative to the per-user, per-month checklist apps (Connecteam, Jolt, Xenia and
similar) for cafes, shops, gyms, arcades, cleaning crews and any other team with shifts.

> **Early release.** ShiftCheck ran daily at a real venue. It has an end-to-end test suite and a
> security review behind it, but it is young: try it with your team before you rely on it.

## What it does

**For staff**
- Pick your name, enter your PIN, and see only the checklists assigned to you, grouped by category.
- Tick off tasks and log them with your signature. Each completion is recorded with who and when.
- Tasks come back on their own: a task can be due again a set number of hours after it was done,
  so "Clean the coffee machine" reappears for the next shift. Overdue tasks are flagged.
- Add notes to a task. New notes from a manager must be read before the task can be logged, so
  instructions don't get skipped.
- A team activity chart shows how much everyone has done over the last week.
- Light and dark mode.

**For managers**
- Admin console: employees, categories, tasks (drag to reorder), who each task is assigned to.
- Full logs of every completion and checkout, with CSV and PDF export.
- Stats: completions over time, daily trend, overdue tasks.
- Three roles: **employee**, **viewer** (can see the admin console but not change anything) and
  **admin**.
- Accounts lock after 10 wrong PINs, and sign-in is rate limited per network address.

## Quick start

Requirements: Node.js 18 or newer and MySQL 8 (or MariaDB 10.5+).

```bash
git clone https://github.com/aprabh96/shiftcheck.git && cd shiftcheck/server
npm install
cp .env.example .env        # set DB_* and a random JWT_SECRET (instructions inside)
npm run create-admin -- --name "Owner"   # asks for a PIN (6+ digits)
npm start
```

Open `http://localhost:3001` for staff and `http://localhost:3001/admin.html` for managers. The
database tables are created on first start. `checklist_schema.sql` has the same schema if you prefer
to create it by hand.

Locked out of the admin account? Run `npm run create-admin -- --name "Owner"` again on the server:
it sets a new PIN and unlocks the account.

### Set it up with an AI agent

Paste this into Codex, Claude Code, Cursor or any coding agent that can reach your server:

```
Install ShiftCheck from https://github.com/aprabh96/shiftcheck on this machine. Read the README first.
Install Node.js 18+ and MySQL if they are missing (ask me before installing anything), create a
database and a user for it, fill in server/.env from .env.example with a random JWT_SECRET, run
"npm install" and "npm run create-admin -- --name Owner" in server/ (let me type the PIN), and keep
it running with a process manager (pm2 or a system service). Put it behind HTTPS if it will be
reachable from the internet, and set TRUST_PROXY=true in that case. Never print the database
password or JWT_SECRET. Tell me the staff and admin URLs when done.
```

## Configuration (`server/.env`)

| Setting | What it does |
| --- | --- |
| `BUSINESS_NAME` | Shown at the top of both pages |
| `PORT` | Port to listen on (default 3001) |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASS` | MySQL connection |
| `JWT_SECRET` | 32+ random characters; the server refuses to start without it |
| `TRUST_PROXY` | `true` only behind a reverse proxy (nginx, Caddy, a load balancer) |
| `GEO_LOOKUP` | `true` to record a city for each sign-in. This sends the employee's IP address to ipapi.co, so it is off by default |
| `CORS_ORIGIN` | Only if the pages are served from another origin; normally empty |

## Security notes

- PINs are stored as bcrypt hashes. Employee PINs need 4+ digits, viewer and admin PINs 6+.
- Staff can only see, complete and comment on the tasks assigned to them; the admin API checks the
  role in the database on every request.
- A PIN is a small secret. If ShiftCheck is reachable from the internet, serve it over HTTPS and
  prefer longer PINs; for a single location, keeping it on the local network is simplest.
- Known: two moderate npm advisories in `uuid`, pulled in by Sequelize 6, affect a feature this app
  does not use. They go away with Sequelize 7.

## Development

```bash
cd server
npm run dev                      # restarts on changes
SMOKE_BASE_URL=http://127.0.0.1:3001 SMOKE_ADMIN_PIN=<your admin PIN> npm test
```

The test signs in, creates people, categories and tasks, and checks that roles and task ownership
are enforced. Run it against a test database, not your real one. GitHub Actions runs it on every push.

## License

Copyright (c) 2025-2026 Prabhsimran Arora.

ShiftCheck is free software under the [GNU Affero General Public License v3.0](LICENSE) or later.
Any business can use it and change it for free. Anyone who distributes it or offers it to others as
a hosted service must publish their complete source code, changes included, under the same license.
Commercial licenses are available for closed-source products: prabh@psynect.ai.

Made by the team behind [OpenArcade](https://github.com/aprabh96/openarcade), where ShiftCheck started
as the daily checklist for a VR arcade's staff.
