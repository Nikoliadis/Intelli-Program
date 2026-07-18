// Κεντρικός Express server.
// ΒΗΜΑ 2: login (session + bcrypt) και API agents. Οι επόμενες οθόνες
// (περίοδος, generator, export) προστίθενται στα επόμενα βήματα.
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const pool = require('./db/pool');
const config = require('./db/config');
const { requireAuth } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const agentsRoutes = require('./routes/agents');
const metaRoutes = require('./routes/meta');
const periodRoutes = require('./routes/period');
const scheduleRoutes = require('./routes/schedule');
const exportRoutes = require('./routes/export');
const importRoutes = require('./routes/import');

const app = express();
const PORT = process.env.PORT || 3000;

// Πίσω από το HTTPS proxy του Railway/Render: σωστό req.ip και ασφαλή cookies
app.set('trust proxy', 1);

const IS_PROD = process.env.NODE_ENV === 'production';

// ---------- Ασφάλεια (18/07/2026) ----------
// Κεφαλίδες: anti-clickjacking, anti-MIME-sniffing, HSTS, CSP.
// Το CSP επιτρέπει inline STYLES (τα χρησιμοποιεί το UI) αλλά ΟΧΙ inline
// scripts — όλη η JS είναι σε εξωτερικά αρχεία, οπότε κόβει XSS στη ρίζα.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    },
    crossOriginEmbedderPolicy: false
  })
);

// Brute-force προστασία στο login: 10 ΑΠΟΤΥΧΗΜΕΝΕΣ προσπάθειες ανά IP / 15'
// (οι επιτυχημένες δεν μετράνε, ώστε να μην ενοχλείται ο κανονικός χρήστης)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Πολλές προσπάθειες σύνδεσης. Δοκίμασε ξανά σε λίγα λεπτά.' }
});
app.use('/api/login', loginLimiter);

// Μεγαλύτερο όριο body: οι validate/save κλήσεις στέλνουν ολόκληρες εβδομάδες αναθέσεων
app.use(express.json({ limit: '5mb' }));

// Τα sessions αποθηκεύονται ΣΤΗ ΒΑΣΗ (πίνακας `sessions`, δημιουργείται
// αυτόματα) — έτσι δεν χάνεται το login σε κάθε deploy/restart στο cloud.
const sessionStore = new MySQLStore({
  host: config.host,
  port: config.port,
  user: config.user,
  password: config.password,
  database: config.database,
  createDatabaseTable: true,
  charset: 'utf8mb4_general_ci'
});

app.use(
  session({
    key: 'programa_vardion_sid',
    secret: process.env.SESSION_SECRET || 'programa-vardion-dev-secret',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,               // δεν διαβάζεται από JavaScript
      sameSite: 'lax',              // προστασία CSRF
      secure: IS_PROD,              // μόνο μέσω HTTPS στην παραγωγή
      maxAge: 8 * 60 * 60 * 1000    // 8 ώρες
    }
  })
);

// Static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// Routes χωρίς auth: login/logout/me
app.use('/api', authRoutes);

// Routes με auth
app.use('/api/agents', requireAuth, agentsRoutes);
app.use('/api', requireAuth, metaRoutes);
app.use('/api', requireAuth, periodRoutes);
app.use('/api/schedule', requireAuth, scheduleRoutes);
app.use('/api/export', requireAuth, exportRoutes);
app.use('/api/import', requireAuth, importRoutes);

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
