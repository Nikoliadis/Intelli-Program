// Οθόνη Περιόδου: υπολογισμός εβδομάδων Δευ-Κυρ + άδειες/αιτήματα ρεπό.
// Οι καταχωρήσεις time_off γίνονται ανά ημερομηνία στη βάση, αλλά το API
// δέχεται ΔΙΑΣΤΗΜΑ (π.χ. άδεια 10/7-17/7 μονομιάς) και στη λίστα οι
// συνεχόμενες μέρες ομαδοποιούνται ξανά σε διαστήματα.
const express = require('express');
const pool = require('../db/pool');
const { weeksCovering, monthBounds, addDays, isValidDate } = require('../utils/dates');

const router = express.Router();

const TIME_OFF_TYPES = ['repo_request', 'leave', 'sick'];

// GET /api/period/weeks?month=YYYY-MM  ή  ?from=YYYY-MM-DD&to=YYYY-MM-DD
// Στρογγυλοποιεί σε πλήρεις εβδομάδες Δευτέρα-Κυριακή που καλύπτουν την περίοδο.
router.get('/period/weeks', (req, res) => {
  let { from, to, month } = req.query;

  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ ok: false, error: 'Μη έγκυρος μήνας (μορφή YYYY-MM)' });
    }
    ({ from, to } = monthBounds(month));
  }
  if (!from || !to || !isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ ok: false, error: 'Δώσε έγκυρες ημερομηνίες από/έως' });
  }
  if (from > to) {
    return res.status(400).json({ ok: false, error: 'Η ημερομηνία "από" είναι μετά την "έως"' });
  }

  const weeks = weeksCovering(from, to);
  if (weeks.length > 10) {
    return res.status(400).json({ ok: false, error: `Η περίοδος καλύπτει ${weeks.length} εβδομάδες — μέγιστο 10. Διάλεξε μικρότερο διάστημα.` });
  }
  res.json({ ok: true, from, to, weeks });
});

// GET /api/timeoff?from=&to= — λίστα καταχωρήσεων, ομαδοποιημένες σε διαστήματα
router.get('/timeoff', async (req, res) => {
  try {
    const { from, to } = req.query;
    const where = [];
    const params = [];
    if (from && isValidDate(from)) { where.push('t.date >= ?'); params.push(from); }
    if (to && isValidDate(to)) { where.push('t.date <= ?'); params.push(to); }

    const [rows] = await pool.query(
      `SELECT t.id, t.agent_id, t.date, t.type, t.notes, a.full_name
       FROM time_off t JOIN agents a ON a.id = t.agent_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY a.full_name, t.type, t.date`,
      params
    );

    // Ομαδοποίηση συνεχόμενων ημερών ίδιου agent + τύπου σε ένα διάστημα
    const groups = [];
    for (const r of rows) {
      const last = groups[groups.length - 1];
      if (
        last &&
        last.agent_id === r.agent_id &&
        last.type === r.type &&
        addDays(last.date_to, 1) === r.date
      ) {
        last.date_to = r.date;
        last.ids.push(r.id);
      } else {
        groups.push({
          ids: [r.id],
          agent_id: r.agent_id,
          agent_name: r.full_name,
          type: r.type,
          date_from: r.date,
          date_to: r.date,
          notes: r.notes
        });
      }
    }
    res.json({ ok: true, entries: groups });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/timeoff — καταχώρηση μεμονωμένης μέρας ή διαστήματος μονομιάς
router.post('/timeoff', async (req, res) => {
  const { agent_id, type, date_from, notes } = req.body || {};
  const date_to = req.body.date_to || date_from;

  if (!agent_id) return res.status(400).json({ ok: false, error: 'Επίλεξε agent' });
  if (!TIME_OFF_TYPES.includes(type)) return res.status(400).json({ ok: false, error: 'Μη έγκυρος τύπος καταχώρησης' });
  if (!date_from || !isValidDate(date_from) || !isValidDate(date_to)) {
    return res.status(400).json({ ok: false, error: 'Μη έγκυρες ημερομηνίες' });
  }
  if (date_from > date_to) return res.status(400).json({ ok: false, error: 'Η ημερομηνία "από" είναι μετά την "έως"' });

  // Όριο ασφαλείας: μέχρι 60 μέρες σε μία καταχώρηση
  const dates = [];
  let d = date_from;
  while (d <= date_to && dates.length <= 60) {
    dates.push(d);
    d = addDays(d, 1);
  }
  if (dates.length > 60) return res.status(400).json({ ok: false, error: 'Το διάστημα ξεπερνά τις 60 ημέρες' });

  const conn = await pool.getConnection();
  try {
    const [[agent]] = await conn.query('SELECT id, full_name, active FROM agents WHERE id = ?', [agent_id]);
    if (!agent) return res.status(404).json({ ok: false, error: 'Δεν βρέθηκε ο agent' });
    if (!agent.active) return res.status(400).json({ ok: false, error: 'Ο agent είναι ανενεργός' });

    // Έλεγχος επικάλυψης: ήδη υπάρχουσα καταχώρηση οποιουδήποτε τύπου τις ίδιες μέρες
    const [existing] = await conn.query(
      'SELECT date, type FROM time_off WHERE agent_id = ? AND date BETWEEN ? AND ? ORDER BY date',
      [agent_id, date_from, date_to]
    );
    if (existing.length) {
      const typeLabels = { repo_request: 'αίτημα ρεπό', leave: 'άδεια', sick: 'ασθένεια' };
      const what = existing.map((e) => `${e.date} (${typeLabels[e.type]})`).slice(0, 5).join(', ');
      return res.status(409).json({
        ok: false,
        error: `Υπάρχει ήδη καταχώρηση για τον/την ${agent.full_name}: ${what}${existing.length > 5 ? '…' : ''}. Διάγραψέ την πρώτα.`
      });
    }

    await conn.beginTransaction();
    for (const date of dates) {
      await conn.query(
        'INSERT INTO time_off (agent_id, date, type, notes) VALUES (?, ?, ?, ?)',
        [agent_id, date, type, notes || null]
      );
    }
    await conn.commit();
    res.json({ ok: true, days: dates.length });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    conn.release();
  }
});

// DELETE /api/timeoff — διαγραφή ομάδας καταχωρήσεων (λίστα ids)
router.delete('/timeoff', async (req, res) => {
  const ids = req.body && req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => Number.isInteger(x))) {
    return res.status(400).json({ ok: false, error: 'Μη έγκυρη λίστα ids' });
  }
  try {
    const [r] = await pool.query('DELETE FROM time_off WHERE id IN (?)', [ids]);
    res.json({ ok: true, deleted: r.affectedRows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
