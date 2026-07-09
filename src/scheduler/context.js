// Φόρτωση όλων των δεδομένων που χρειάζεται ο generator από τη βάση:
// agents (με skills + δομημένους κανόνες), απαιτήσεις κάλυψης, λίστα
// επιλεξιμότητας 19:00-03:00, άδειες/ρεπό, ρόλοι/χρώματα, και η κατάσταση
// της τελευταίας αποθηκευμένης εβδομάδας ΠΡΙΝ την περίοδο (για Κ8/Κ10
// στο ξεκίνημα).
const pool = require('../db/pool');

async function loadContext(periodStart, periodEnd) {
  // --- Agents (μόνο ενεργοί) ---
  const [agentRows] = await pool.query('SELECT * FROM agents WHERE active = 1 ORDER BY full_name');
  const [skillRows] = await pool.query(
    `SELECT ask.agent_id, s.name FROM agent_skills ask JOIN skills s ON s.id = ask.skill_id`
  );
  const [ruleRows] = await pool.query(
    'SELECT agent_id, description, rule FROM agent_constraints ORDER BY id'
  );

  const agents = agentRows.map((r) => ({
    id: r.id,
    name: r.full_name,
    company: r.company,
    departments: JSON.parse(r.departments || '[]'),
    canNight: r.can_night === 1,
    isNew: r.is_new === 1,
    fixedStart: r.fixed_shift_start,
    fixedEnd: r.fixed_shift_end,
    fixedDays: r.fixed_days ? JSON.parse(r.fixed_days) : null,
    fixedDaysOff: r.fixed_days_off ? JSON.parse(r.fixed_days_off) : [],
    weekendShift: r.weekend_shift,
    workLocation: r.work_location || 'office',
    skills: new Set(),
    rules: []
  }));
  const byId = new Map(agents.map((a) => [a.id, a]));
  for (const s of skillRows) {
    if (byId.has(s.agent_id)) byId.get(s.agent_id).skills.add(s.name);
  }
  for (const r of ruleRows) {
    if (!byId.has(r.agent_id) || !r.rule) continue;
    const rule = typeof r.rule === 'string' ? JSON.parse(r.rule) : r.rule;
    byId.get(r.agent_id).rules.push(rule);
  }

  // --- Απαιτήσεις κάλυψης ---
  const [reqRows] = await pool.query(
    `SELECT sr.*, s.name AS skill_name, ro.name AS role_name, ro.color_argb
     FROM shift_requirements sr
     LEFT JOIN skills s ON s.id = sr.skill_id
     LEFT JOIN roles ro ON ro.id = sr.role_id
     ORDER BY sr.start_time`
  );
  const requirements = { weekday: [], weekend: [] };
  for (const r of reqRows) {
    requirements[r.day_type].push({
      id: r.id,
      start: r.start_time,
      end: r.end_time,
      skill: r.skill_name,
      department: r.department,
      headcount: r.headcount,
      label: r.label,
      roleId: r.role_id,
      color: r.color_argb
    });
  }

  // --- Λίστα 19:00-03:00 (Κ9) ---
  const [eligRows] = await pool.query('SELECT * FROM shift_eligibility');
  const eligibility = new Map(); // agent_id → {maxPerWeek, location, notAlone}
  for (const e of eligRows) {
    eligibility.set(e.agent_id, {
      maxPerWeek: e.max_per_week,
      location: e.location,
      notAlone: e.not_alone === 1
    });
  }

  // --- Άδειες / αιτήματα ρεπό της περιόδου ---
  const [toRows] = await pool.query(
    'SELECT agent_id, date, type FROM time_off WHERE date BETWEEN ? AND ?',
    [periodStart, periodEnd]
  );
  const timeOff = new Map(); // 'agentId|date' → type
  for (const t of toRows) timeOff.set(`${t.agent_id}|${t.date}`, t.type);

  // --- Χρώματα ρόλων για προτάσεις ---
  const [roleRows] = await pool.query('SELECT id, name, color_argb FROM roles');
  const roles = new Map(roleRows.map((r) => [r.name, { id: r.id, color: r.color_argb }]));

  // --- Κατάσταση από την τελευταία αποθηκευμένη εβδομάδα πριν την περίοδο ---
  const [prevRows] = await pool.query(
    'SELECT data FROM schedules WHERE week_start < ? ORDER BY week_start DESC, id DESC LIMIT 1',
    [periodStart]
  );
  let initialState = {};
  if (prevRows[0]) {
    try {
      const data = JSON.parse(prevRows[0].data);
      initialState = data.state || {};
    } catch {
      initialState = {};
    }
  }

  return { agents, requirements, eligibility, timeOff, roles, initialState };
}

module.exports = { loadContext };
