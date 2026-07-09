// Βοηθητικά δεδομένα για τις φόρμες του UI: δεξιότητες, ρόλοι/χρώματα,
// σταθερές λίστες εταιριών/τμημάτων.
const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/meta', async (req, res) => {
  try {
    const [skills] = await pool.query('SELECT id, name FROM skills ORDER BY id');
    const [roles] = await pool.query('SELECT id, name, color_argb FROM roles ORDER BY id');
    res.json({
      ok: true,
      skills,
      roles,
      companies: ['OPTIVA', 'INTELLI'],
      departments: [
        { value: 'call', label: 'Call' },
        { value: 'verification', label: 'Verification' },
        { value: 'supervisor', label: 'Supervisor' }
      ]
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
