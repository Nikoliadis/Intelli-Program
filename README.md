# Shift Scheduler — Intelli Program

***English** · [Ελληνικά](README.el.md)*

Automated **weekly shift scheduling** for a call center. Generates rosters that
respect labour law (11-hour rest, no 6-day weeks), per-project coverage
requirements and each employee's individual constraints — with manual editing
and Excel import/export.

🔗 **Live:** https://intelli-program-production.up.railway.app

---

## What it does

- **Automatic generation** for a whole period (multiple weeks at once), carrying
  state from one week to the next (consecutive-day streaks, rest hours).
- **Agent management**: departments, skills, fixed shifts, individual
  constraints, leave.
- **Manual editing** of the generated roster with **live rule validation**
  (and a hard block when the 11-hour rest would be violated).
- **Excel export** matching the office's exact style (colours, role grouping).
- **Excel import**: upload a previous week and the generator takes it into
  account at the boundaries (who worked 5 days straight → day off on Monday).
- **Users with permissions** (full / restricted).

## Tech stack

Node.js + Express · MariaDB/MySQL (mysql2) · vanilla JS frontend · ExcelJS ·
express-session (sessions stored in the database) · bcryptjs · helmet ·
express-rate-limit

---

## Quick start (local)

Requirements: **Node.js ≥ 20** and a running **MySQL/MariaDB** (e.g. XAMPP).

```bash
npm install
npm run setup     # creates tables (migrate) + initial data (seed)
npm run dev       # http://localhost:3000
```

Initial user after seeding: **admin / admin** — change it immediately (see Scripts).

## Environment variables

All optional locally — sensible defaults for a local XAMPP setup.

| Variable | Description |
|---|---|
| `DATABASE_URL` / `MYSQL_URL` | Full connection string (Railway provides one). Takes precedence. |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Individual connection settings (defaults: `localhost` / `root` / `programa_vardion`). |
| `SESSION_SECRET` | Secret used to sign the session cookie. **Required in production.** |
| `NODE_ENV` | `production` in the cloud — enables `secure` cookies. |
| `PORT` | Server port (default 3000). |

## Scripts

```bash
npm run dev        # development with auto-reload (nodemon)
npm start          # production
npm run migrate    # create/update tables
npm run seed       # initial data (agents, requirements, roles, admin user)
npm run setup      # migrate + seed together

# Validate the generator's rules over one month (23 checks)
node scripts/test_generator.js 2026-07

# User management
node scripts/set_password.js <username> <new-password>
node scripts/create_user.js <username> <password> [displayName] [--no-edit-agents]
```

> Prefix any script with `DATABASE_URL=...` to run it against the production database.

---

## Screens

| Screen | Path | Purpose |
|---|---|---|
| **Agents** | `/` | List/CRUD of employees, skills, constraints, deactivation (soft delete). |
| **Period** | `/period.html` | Define the period (rounded to Monday–Sunday), leave and day-off requests. |
| **Excel check** | `/import.html` | Upload a week's Excel → see **per agent** what was parsed plus the streak carried forward. Preview without saving. |
| **Schedule** | `/schedule.html` | Generate, preview per week, edit manually with live validation, export to Excel. |

Workflow: **Agents → Period → Excel check → Schedule**

---

## Scheduling rules

### Hard constraints (never violated)

| | Rule |
|---|---|
| **K1** | Every coverage requirement is filled by an agent with the matching role/skill. |
| **K2** | 1 shift per day, 5 working days + **exactly 2 days off** per week. |
| **K3** | Per-agent constraints (studies, fixed shifts, mornings/afternoons only, remote work, split shifts). |
| **K4** | Night shift starts 23:00 or 23:30 depending on whether someone opens at 07:00/07:30. |
| **K5** | Fixed ("locked") shifts are always honoured. |
| **K6** | An agent on leave is never scheduled. |
| **K7** | Night shifts only for agents flagged `can_night`. |
| **K8** | **At least 11 hours of rest** between shifts — enforced across week boundaries too. |
| **K9** | The 19:00–03:00 shift only from an eligibility list, with a weekly cap per agent. |
| **K10** | **No 6-day stretches** — at most 5 consecutive days, then a mandatory day off. |

### Soft constraints (preferences, in priority order)

- **S1** Friday 06:00–14:00: pair the two remote-eligible agents together when feasible.
- **S2** The 2 days off should be **consecutive** (unless requested otherwise, or blocked).
- **S3** Fair rotation of night shifts, weekends and Sundays.
- **S4** Consistent shift times within a week (avoid morning–night–morning).
- **S5** Agents restricted to mornings keep their allowed start times.

### Additional operational rules

- **Weekends**: the headcounts are both **MAX and MIN** (2 Eurobank morning /
  afternoon, 2 Alpha morning / afternoon, 1 Piraeus 06:00–14:00, 1 Piraeus
  afternoon, 1 Verification morning, 1 Verification afternoon).
- **Supervisors**: **only** 07:00–15:00 and 16:00–24:00; any extra/second
  supervisor is **always** 08:00–16:00. One morning and one afternoon
  supervisor every day, Monday–Sunday.
- **Night shifts**: max 2 per week, consecutive only, followed by an equal
  number of rest days.
- **Sundays**: max 2 per month per agent — except when a Sunday slot is the only
  way for that agent to end up with **exactly 2 days off**.
- **Imported weeks** (from Excel) are treated as **established fact**: they are
  never regenerated and they feed the K8/K10 checks both forwards and backwards.

---

## Excel

- **Export**: per week or for a whole period, faithful to the office's layout
  (hourly bands vertically, days horizontally, colour per role, grouped columns).
- **Import**: detects day blocks from the fill colours, matches names (tolerant
  of typos) and merges night shifts that cross midnight. Use the **Excel check**
  screen to verify the parse before saving.

## Users & permissions

The `users` table has a `can_edit_agents` column:

- **Full access** (`1`, default) — everything.
- **Restricted** (`0`) — the "Edit" button on agents is hidden (and blocked
  server-side), and the "Constraints" column is **not visible** (stripped from
  the API response, not merely hidden in the UI).

```bash
node scripts/create_user.js someuser 'password' 'Display Name' --no-edit-agents
```

## Security

- Passwords hashed with **bcrypt**; sessions stored **in the database** (they
  survive restarts and redeploys).
- Cookies are `HttpOnly` + `SameSite=Lax` + `Secure` (in production).
- **helmet**: strict CSP (no inline JS at all), HSTS, anti-clickjacking, nosniff.
- **Rate limiting** on login: 10 failed attempts per IP per 15 minutes.
- Parameterised SQL queries throughout (no SQL injection).
- In production the database is **not exposed to the internet** — private
  network only.

## Deployment

Step-by-step **Railway** instructions (including data migration):
**[DEPLOY.md](DEPLOY.md)**

Every `git push` triggers an automatic redeploy.

---

## Project layout

```
src/
  server.js            Express app, security, sessions, routes
  db/                  config, pool, migrate, seed
  routes/              auth, agents, meta, period, schedule, export, import
  scheduler/
    index.js           generatePeriod — multi-week generation carrying state forward
    engine.js          the algorithm (phases: lock → nights → requirements → days off → fillers)
    validate.js        rule checks (live validation & boundary state)
    context.js         loads everything the generator needs from the database
  middleware/auth.js   requireAuth
  utils/dates.js       date/week helpers
public/                frontend (HTML + vanilla JS per screen)
scripts/               test_generator, set_password, create_user
SPEC_Programma_Vardion.md   The specification (source of truth for the rules)
```

## Tests

```bash
node scripts/test_generator.js 2026-07
```

Runs 23 checks against a real month's generated output: K2/K8/K10, night shifts,
19:00–03:00, weekend MAX/MIN, Sunday caps, supervisors, the 06:00–14:00
eligibility list and more. Imported weeks are excluded (they are data, not
output) — only their boundaries are checked.
