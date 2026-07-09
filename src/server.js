// Κεντρικός Express server.
// ΒΗΜΑ 2: login (session + bcrypt) και API agents. Οι επόμενες οθόνες
// (περίοδος, generator, export) προστίθενται στα επόμενα βήματα.
const express = require('express');
const session = require('express-session');
const path = require('path');
const pool = require('./db/pool');
const { requireAuth } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const agentsRoutes = require('./routes/agents');
const metaRoutes = require('./routes/meta');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'programa-vardion-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 } // 8 ώρες
  })
);

// Static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// Routes χωρίς auth: login/logout/me
app.use('/api', authRoutes);

// Routes με auth
app.use('/api/agents', requireAuth, agentsRoutes);
app.use('/api', requireAuth, metaRoutes);

// Health check: επιβεβαιώνει σύνδεση με τη βάση και μετρά βασικά δεδομένα
app.get('/api/health', async (req, res) => {
  try {
    const [[agents]] = await pool.query('SELECT COUNT(*) AS n FROM agents WHERE active = 1');
    const [[reqs]] = await pool.query('SELECT COUNT(*) AS n FROM shift_requirements');
    const [[elig]] = await pool.query('SELECT COUNT(*) AS n FROM shift_eligibility');
    const [[cons]] = await pool.query('SELECT COUNT(*) AS n FROM agent_constraints');
    res.json({
      ok: true,
      database: 'programa_vardion',
      agents: agents.n,
      shift_requirements: reqs.n,
      shift_eligibility: elig.n,
      agent_constraints: cons.n
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Ο server τρέχει στο http://localhost:${PORT}`);
});
