// CRUD agents + δεξιότητες + constraints.
// Διαγραφή agent ΔΕΝ υπάρχει — μόνο απενεργοποίηση (active = 0), ώστε το
// ιστορικό προγραμμάτων να μη «σπάει» (βλ. ενότητα 6 του spec).
const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// Βοηθητικό: parse των JSON στηλών ενός agent row
function parseAgent(row) {
  return {
    ...row,
    departments: row.departments ? JSON.parse(row.departments) : [],
    fixed_days: row.fixed_days ? JSON.parse(row.fixed_days) : null,
    fixed_days_off: row.fixed_days_off ? JSON.parse(row.fixed_days_off) : null
  };
}

// Βοηθητικό: φόρτωση skills + constraints για λίστα agent ids
async function attachDetails(agents) {
  if (agents.length === 0) return agents;
  const ids = agents.map((a) => a.id);
  const [skills] = await pool.query(
    `SELECT ask.agent_id, s.id, s.name
     FROM agent_skills ask JOIN skills s ON s.id = ask.skill_id
     WHERE ask.agent_id IN (?)`,
    [ids]
  );
  const [constraints] = await pool.query(
    `SELECT id, agent_id, day_of_week, allowed_shifts, required_shift, description
     FROM agent_constraints WHERE agent_id IN (?) ORDER BY id`,
    [ids]
  );
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  for (const a of agents) {
    a.skills = [];
    a.constraints = [];
  }
  for (const s of skills) byId[s.agent_id].skills.push({ id: s.id, name: s.name });
  for (const c of constraints) byId[c.agent_id].constraints.push(c);
  return agents;
}

// GET /api/agents?q=&company=&department=&active=
// active: '1' (default) | '0' | 'all'
router.get('/', async (req, res) => {
  try {
    const { q, company, department } = req.query;
    const active = req.query.active === undefined ? '1' : String(req.query.active);
    const where = [];
    const params = [];

    if (active !== 'all') {
      where.push('active = ?');
      params.push(Number(active));
    }
    if (q) {
      where.push('full_name LIKE ?');
      params.push(`%${q}%`);
    }
    if (company) {
      where.push('company = ?');
      params.push(company);
    }
    if (department) {
      // Τα departments είναι JSON λίστα π.χ. ["call"] — αναζήτηση με LIKE στο κλειδί
      where.push("departments LIKE CONCAT('%\"', ?, '\"%')");
      params.push(department);
    }

    const sql = `SELECT * FROM agents
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY full_name`;
    const [rows] = await pool.query(sql, params);
    const agents = await attachDetails(rows.map(parseAgent));
    res.json({ ok: true, agents });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/agents/:id
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM agents WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'Δεν βρέθηκε ο agent' });
    const [agent] = await attachDetails([parseAgent(rows[0])]);
    res.json({ ok: true, agent });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Επικύρωση + κανονικοποίηση payload agent από το frontend
function validateAgentPayload(body) {
  const errors = [];
  if (!body.full_name || !body.full_name.trim()) errors.push('Το ονοματεπώνυμο είναι υποχρεωτικό');
  if (!Array.isArray(body.departments) || body.departments.length === 0) {
    errors.push('Επίλεξε τουλάχιστον ένα τμήμα');
  }
  const timeRe = /^([01]?\d|2[0-3]):[0-5]\d$/;
  if (body.fixed_shift_start && !timeRe.test(body.fixed_shift_start)) errors.push('Μη έγκυρη ώρα έναρξης σταθερού ωραρίου');
  if (body.fixed_shift_end && !timeRe.test(body.fixed_shift_end) && body.fixed_shift_end !== '24:00') errors.push('Μη έγκυρη ώρα λήξης σταθερού ωραρίου');
  if ((body.fixed_shift_start && !body.fixed_shift_end) || (!body.fixed_shift_start && body.fixed_shift_end)) {
    errors.push('Το σταθερό ωράριο χρειάζεται και έναρξη και λήξη');
  }
  return errors;
}

// Κοινά πεδία agent για INSERT/UPDATE
function agentParams(body) {
  return [
    body.full_name.trim(),
    body.company || null,
    JSON.stringify(body.departments),
    body.can_night === null || body.can_night === undefined || body.can_night === '' ? null : (body.can_night ? 1 : 0),
    body.is_new ? 1 : 0,
    body.fixed_shift_start || null,
    body.fixed_shift_end || null,
    Array.isArray(body.fixed_days) && body.fixed_days.length ? JSON.stringify(body.fixed_days) : null,
    Array.isArray(body.fixed_days_off) && body.fixed_days_off.length ? JSON.stringify(body.fixed_days_off) : null,
    body.weekend_shift || null,
    body.work_location || null,
    body.notes || null
  ];
}

// Sync δεξιοτήτων και constraints ενός agent μέσα σε transaction
async function syncDetails(conn, agentId, body) {
  if (Array.isArray(body.skill_ids)) {
    await conn.query('DELETE FROM agent_skills WHERE agent_id = ?', [agentId]);
    for (const sid of body.skill_ids) {
      await conn.query('INSERT INTO agent_skills (agent_id, skill_id) VALUES (?, ?)', [agentId, sid]);
    }
  }
  if (Array.isArray(body.constraints)) {
    // Κρατάμε όσα ids ήρθαν, σβήνουμε τα υπόλοιπα, ενημερώνουμε/προσθέτουμε
    const keepIds = body.constraints.filter((c) => c.id).map((c) => c.id);
    if (keepIds.length) {
      await conn.query('DELETE FROM agent_constraints WHERE agent_id = ? AND id NOT IN (?)', [agentId, keepIds]);
    } else {
      await conn.query('DELETE FROM agent_constraints WHERE agent_id = ?', [agentId]);
    }
    for (const c of body.constraints) {
      const desc = (c.description || '').trim();
      if (!desc) continue;
      if (c.id) {
        await conn.query('UPDATE agent_constraints SET description = ? WHERE id = ? AND agent_id = ?', [desc, c.id, agentId]);
      } else {
        await conn.query('INSERT INTO agent_constraints (agent_id, description) VALUES (?, ?)', [agentId, desc]);
      }
    }
  }
}

// POST /api/agents — νέος agent
router.post('/', async (req, res) => {
  const errors = validateAgentPayload(req.body);
  if (errors.length) return res.status(400).json({ ok: false, error: errors.join('. ') });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO agents
       (full_name, company, departments, can_night, is_new, fixed_shift_start,
        fixed_shift_end, fixed_days, fixed_days_off, weekend_shift, work_location, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      agentParams(req.body)
    );
    await syncDetails(conn, result.insertId, req.body);
    await conn.commit();
    res.json({ ok: true, id: result.insertId });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    conn.release();
  }
});

// PUT /api/agents/:id — ενημέρωση agent
router.put('/:id', async (req, res) => {
  // Δικαίωμα «Επεξεργασία agent» (18/07/2026): μπλοκάρεται server-side ώστε
  // να μην παρακάμπτεται από το frontend
  if (req.session && req.session.canEditAgents === false) {
    return res.status(403).json({ ok: false, error: 'Δεν έχεις δικαίωμα επεξεργασίας agents.' });
  }
  const errors = validateAgentPayload(req.body);
  if (errors.length) return res.status(400).json({ ok: false, error: errors.join('. ') });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `UPDATE agents SET
       full_name = ?, company = ?, departments = ?, can_night = ?, is_new = ?,
       fixed_shift_start = ?, fixed_shift_end = ?, fixed_days = ?, fixed_days_off = ?,
       weekend_shift = ?, work_location = ?, notes = ?
       WHERE id = ?`,
      [...agentParams(req.body), req.params.id]
    );
    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: 'Δεν βρέθηκε ο agent' });
    }
    await syncDetails(conn, Number(req.params.id), req.body);
    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    conn.release();
  }
});

// PUT /api/agents/:id/active — απενεργοποίηση/επανενεργοποίηση (ΠΟΤΕ hard delete)
router.put('/:id/active', async (req, res) => {
  try {
    const active = req.body.active ? 1 : 0;
    const [result] = await pool.query('UPDATE agents SET active = ? WHERE id = ?', [active, req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ ok: false, error: 'Δεν βρέθηκε ο agent' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
