// Routes σύνδεσης/αποσύνδεσης προϊσταμένων (express-session + bcrypt)
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const router = express.Router();

// POST /api/login — έλεγχος στοιχείων και δημιουργία session
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Συμπλήρωσε όνομα χρήστη και κωδικό' });
  }
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ ok: false, error: 'Λάθος όνομα χρήστη ή κωδικός' });
    }
    req.session.userId = user.id;
    req.session.displayName = user.display_name || user.username;
    res.json({ ok: true, displayName: req.session.displayName });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/logout — καταστροφή session
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /api/me — ποιος είναι συνδεδεμένος (για έλεγχο από το frontend)
router.get('/me', (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({ ok: true, displayName: req.session.displayName });
  }
  res.status(401).json({ ok: false });
});

module.exports = router;
