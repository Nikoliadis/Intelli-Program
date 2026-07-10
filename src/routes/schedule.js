// API προγράμματος: παραγωγή, live έλεγχος χειροκίνητων αλλαγών,
// αποθήκευση/φόρτωση εβδομάδων.
const express = require('express');
const pool = require('../db/pool');
const { generatePeriod } = require('../scheduler');
const { validateWeek, computeStateFromAssignments } = require('../scheduler/validate');
const { weeksCovering, monthBounds, isValidDate, addDays } = require('../utils/dates');

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

// POST /api/schedule/validate — live έλεγχος εβδομάδας μετά από χειροκίνητες
// αλλαγές. Ο client στέλνει και τις γειτονικές εβδομάδες όπως τις έχει στη
// μνήμη (με τυχόν μη αποθηκευμένες αλλαγές) — αλλιώς φορτώνονται από τη βάση.
router.post('/validate', async (req, res) => {
  try {
    const { weekStart, assignments, prevAssignments, nextAssignments } = req.body || {};
    if (!weekStart || !isValidDate(weekStart)) {
      return res.status(400).json({ ok: false, error: 'Μη έγκυρη εβδομάδα' });
    }

    let prev = prevAssignments;
    let prevState = null;
    if (!prev) {
      const [rows] = await pool.query(
        'SELECT data FROM schedules WHERE week_start = ? ORDER BY id DESC LIMIT 1',
        [addDays(weekStart, -7)]
      );
      if (rows[0]) {
        const data = JSON.parse(rows[0].data);
        prev = data.assignments;
        prevState = data.state;
      } else {
        // Κατάσταση από την τελευταία αποθηκευμένη εβδομάδα πριν την τρέχουσα
        const [st] = await pool.query(
          'SELECT data FROM schedules WHERE week_start < ? ORDER BY week_start DESC, id DESC LIMIT 1',
          [weekStart]
        );
        if (st[0]) prevState = JSON.parse(st[0].data).state;
      }
    }
    let next = nextAssignments;
    if (!next) {
      const [rows] = await pool.query(
        'SELECT data FROM schedules WHERE week_start = ? ORDER BY id DESC LIMIT 1',
        [addDays(weekStart, 7)]
      );
      if (rows[0]) next = JSON.parse(rows[0].data).assignments;
    }

    const result = await validateWeek({
      weekStart,
      assignments: assignments || [],
      prevAssignments: prev,
      prevState,
      nextAssignments: next
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/schedule/save — αποθήκευση εβδομάδας (νέα εγγραφή = ιστορικό).
// Η κατάσταση τέλους εβδομάδας ΞΑΝΑϋπολογίζεται από τις τελικές αναθέσεις.
router.post('/save', async (req, res) => {
  const { weekStart, assignments, report } = req.body || {};
  if (!weekStart || !isValidDate(weekStart) || !Array.isArray(assignments)) {
    return res.status(400).json({ ok: false, error: 'Μη έγκυρα δεδομένα' });
  }

  const conn = await pool.getConnection();
  try {
    // Κατάσταση προηγούμενης εβδομάδας για σωστούς μετρητές
    const [prevRows] = await conn.query(
      'SELECT data FROM schedules WHERE week_start < ? ORDER BY week_start DESC, id DESC LIMIT 1',
      [weekStart]
    );
    const prevState = prevRows[0] ? JSON.parse(prevRows[0].data).state : null;
    const state = await computeStateFromAssignments(weekStart, assignments, prevState);

    await conn.beginTransaction();
    const [ins] = await conn.query(
      'INSERT INTO schedules (week_start, data) VALUES (?, ?)',
      [weekStart, JSON.stringify({ assignments, state, report: report || null })]
    );
    const scheduleId = ins.insertId;

    for (const a of assignments) {
      if (a.off) continue;
      await conn.query(
        `INSERT INTO assignments
         (schedule_id, agent_id, date, start_time, end_time, role_id, color_argb, label, is_manual_edit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [scheduleId, a.agentId, a.date, a.start, a.end, a.roleId || null, a.color || null, a.label || null, a.isManualEdit ? 1 : 0]
      );
    }
    await conn.commit();
    res.json({ ok: true, scheduleId });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    conn.release();
  }
});

// GET /api/schedule/week?start=YYYY-MM-DD — τελευταία αποθηκευμένη έκδοση
router.get('/week', async (req, res) => {
  try {
    const { start } = req.query;
    if (!start || !isValidDate(start)) return res.status(400).json({ ok: false, error: 'Μη έγκυρη εβδομάδα' });
    const [rows] = await pool.query(
      'SELECT id, week_start, created_at, data FROM schedules WHERE week_start = ? ORDER BY id DESC LIMIT 1',
      [start]
    );
    if (!rows[0]) return res.json({ ok: true, saved: false });
    const data = JSON.parse(rows[0].data);
    res.json({
      ok: true,
      saved: true,
      scheduleId: rows[0].id,
      savedAt: rows[0].created_at,
      assignments: data.assignments,
      report: data.report
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
