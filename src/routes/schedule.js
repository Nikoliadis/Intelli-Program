// API generator: παράγει πρόγραμμα για περίοδο (χωρίς αποθήκευση — preview).
// Η αποθήκευση/επεξεργασία έρχεται στο ΒΗΜΑ 5.
const express = require('express');
const { generatePeriod } = require('../scheduler');
const { weeksCovering, monthBounds, isValidDate } = require('../utils/dates');

const router = express.Router();

// POST /api/schedule/generate  body: {month:'YYYY-MM'} ή {from,to}
router.post('/generate', async (req, res) => {
  try {
    let { from, to, month } = req.body || {};
    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ ok: false, error: 'Μη έγκυρος μήνας' });
      ({ from, to } = monthBounds(month));
    }
    if (!from || !to || !isValidDate(from) || !isValidDate(to) || from > to) {
      return res.status(400).json({ ok: false, error: 'Μη έγκυρη περίοδος' });
    }
    const weeks = weeksCovering(from, to);
    if (weeks.length > 10) return res.status(400).json({ ok: false, error: 'Μέγιστο 10 εβδομάδες' });

    const result = await generatePeriod(weeks);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
