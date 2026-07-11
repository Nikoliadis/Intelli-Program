// Seed αρχικών δεδομένων:
//  1. Ρόλοι/χρώματα (ενότητα 3 του spec)
//  2. Δεξιότητες (skills)
//  3. Απαιτήσεις κάλυψης βαρδιών (ενότητα 4 — καθημερινές + ΣΚ)
//  4. Αρχικός χρήστης admin/admin
//  5. Import seed_agents.json: agents + skills + constraints + λίστα 19:00-03:00
//
// Εκτελείται με: npm run seed
// Είναι idempotent: ό,τι υπάρχει ήδη ΔΕΝ ξαναγράφεται. Με --force αδειάζουν
// και ξαναγεμίζουν οι πίνακες αναφοράς (agents/roles/skills/requirements) —
// ΟΧΙ τα schedules/assignments/time_off.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./pool');

const FORCE = process.argv.includes('--force');

// ---- 1. Ρόλοι/χρώματα — ενότητα 3 του spec (ARGB) ----
const ROLES = [
  { name: 'Supervisor', color_argb: 'FFC792D6' },
  { name: 'Πειραιώς', color_argb: 'FFFFE699' },
  { name: 'Ήρων', color_argb: 'FFC6E0B4' },
  { name: 'Eurobank', color_argb: 'FF66CCFF' },
  { name: 'Υπόλοιπα call', color_argb: 'FFF4B084' },
  { name: 'Νέος agent (προς επιβεβαίωση)', color_argb: 'FF2F5496' },
  { name: 'Verification', color_argb: 'FFA6A6A6' },
  { name: 'Ροδακινί (προς επιβεβαίωση)', color_argb: 'FFFCE4D6' },
  { name: 'Σκούρο κίτρινο (προς επιβεβαίωση)', color_argb: 'FFFFC000' }
];

// ---- 3. Απαιτήσεις κάλυψης — αποφάσεις προϊσταμένου 10-11/07/2026 ----
// period: 'morning'/'afternoon' = απαίτηση «Χ άτομα του ρόλου σε πρωινή/
// απογευματινή βάρδια» (οποιοδήποτε ωράριο της περιόδου — το start/end είναι
// το ΠΡΟΕΠΙΛΕΓΜΕΝΟ για νέες τοποθετήσεις). period null = ακριβές ωράριο.
// department με '+' σημαίνει ότι απαιτούνται ΟΛΑ τα τμήματα.
// Καθημερινές: Πειραιώς 9 πρωί (1 εξ αυτών 06:00-14:00 από τη λίστα 6-2)
// + 2 απόγευμα, ΗΡΩΝ 3 πρωί + 2 απόγευμα, Verification 4 πρωί + 5 απόγευμα
// (ΟΠΩΣΔΗΠΟΤΕ — ξεχωριστές μετρήσεις, κάθε άτομο μετρά σε ΜΙΑ κατηγορία),
// calls: 2 Alpha (1 ΑΠΕΔ) + 1 International + 2 Eurobank + 1 Verif&call Euro.
// ΣΚ: Πειραιώς 1+1, Verification 1+1, Eurobank 2+2, Alpha 2+2.
// Η ΣΕΙΡΑ έχει σημασία: τα ακριβή/ειδικά πρώτα, τα γενικά (period) μετά,
// ώστε κάθε άτομο να μετρηθεί στη σωστή κατηγορία.
// Η νυχτερινή αποθηκεύεται ως 23:00-07:00 — η εναλλακτική 23:30-07:30
// αποφασίζεται από τον generator βάσει του κανόνα Κ4.
const REQUIREMENTS = {
  weekday: [
    // Το 06:00-14:00 καλύπτεται ΑΠΟΚΛΕΙΣΤΙΚΑ από τη λίστα επιλεξιμότητας
    // (Παπασαράντου Κ., Νικολιάδης, Νικολιάδη, Οικονομοπούλου, Λαμπριανίδου,
    // Νικολαΐδου + Ρίζου μόνο ΣΚ) με δίκαιη εναλλαγή — απόφαση 12/07/2026.
    // Χωρίς απαίτηση skill: η λίστα ορίζει ποιοι το κάνουν (όπως η 19:00-03:00).
    { start: '06:00', end: '14:00', skill: null, department: null, period: null, headcount: 1, label: 'Πειραιώς', color: 'Πειραιώς' },
    { start: '07:00', end: '15:00', skill: null, department: 'supervisor', period: null, headcount: 1, label: 'Supervisor', color: 'Supervisor' },
    { start: '07:30', end: '15:30', skill: 'EUROBANK', department: 'call', period: null, headcount: 1, label: 'Eurobank', color: 'Eurobank' },
    { start: '07:30', end: '15:30', skill: 'INTERNATIONAL', department: 'call', period: null, headcount: 1, label: 'International', color: 'Υπόλοιπα call' },
    { start: '08:00', end: '16:00', skill: 'EUROBANK', department: 'call', period: null, headcount: 1, label: 'Eurobank (μόνο)', color: 'Eurobank' },
    { start: '08:00', end: '16:00', skill: 'ΑΠΕΔ', department: 'call', period: null, headcount: 1, label: 'Alpha/ΑΠΕΔ', color: 'Υπόλοιπα call' },
    { start: '08:00', end: '16:00', skill: 'ALPHA', department: 'call', period: null, headcount: 1, label: 'Alpha', color: 'Υπόλοιπα call' },
    { start: '08:00', end: '16:00', skill: 'EUROBANK', department: 'verification+call', period: null, headcount: 1, label: 'Verification & call Eurobank', color: 'Verification' },
    { start: '09:00', end: '17:00', skill: 'ΗΡΩΝ', department: null, period: 'morning', headcount: 3, label: 'Ήρων', color: 'Ήρων' },
    { start: '08:00', end: '16:00', skill: 'ΠΕΙΡΑΙΩΣ', department: null, period: 'morning', headcount: 8, label: 'Πειραιώς', color: 'Πειραιώς' },
    { start: '08:00', end: '16:00', skill: null, department: 'verification', period: 'morning', headcount: 4, label: 'Verification', color: 'Verification' },
    { start: '15:00', end: '23:00', skill: null, department: 'supervisor', period: null, headcount: 1, label: 'Supervisor', color: 'Supervisor' },
    { start: '15:30', end: '23:30', skill: 'EUROBANK', department: 'call', period: null, headcount: 1, label: 'Eurobank', color: 'Eurobank' },
    { start: '15:30', end: '23:30', skill: 'INTERNATIONAL', department: 'call', period: null, headcount: 1, label: 'International', color: 'Υπόλοιπα call' },
    { start: '16:00', end: '24:00', skill: 'EUROBANK', department: 'call', period: null, headcount: 1, label: 'Eurobank (μόνο)', color: 'Eurobank' },
    { start: '16:00', end: '24:00', skill: 'ΑΠΕΔ', department: 'call', period: null, headcount: 1, label: 'Alpha/ΑΠΕΔ', color: 'Υπόλοιπα call' },
    { start: '16:00', end: '24:00', skill: 'ALPHA', department: 'call', period: null, headcount: 1, label: 'Alpha', color: 'Υπόλοιπα call' },
    { start: '16:00', end: '24:00', skill: 'EUROBANK', department: 'verification+call', period: null, headcount: 1, label: 'Verification & call Eurobank', color: 'Verification' },
    { start: '16:00', end: '24:00', skill: 'ΗΡΩΝ', department: null, period: 'afternoon', headcount: 2, label: 'Ήρων', color: 'Ήρων' },
    { start: '16:00', end: '24:00', skill: 'ΠΕΙΡΑΙΩΣ', department: null, period: 'afternoon', headcount: 2, label: 'Πειραιώς', color: 'Πειραιώς' },
    { start: '16:00', end: '24:00', skill: null, department: 'verification', period: 'afternoon', headcount: 5, label: 'Verification', color: 'Verification' },
    { start: '19:00', end: '03:00', skill: null, department: null, period: null, headcount: 1, label: 'Verification & call υπόλοιπα', color: 'Verification' },
    { start: '23:00', end: '07:00', skill: 'EUROBANK', department: null, period: null, headcount: 1, label: 'Νυχτερινή Eurobank', color: 'Eurobank' }
  ],
  weekend: [
    // ΣΚ: ο πρωινός Πειραιώς δουλεύει ΑΚΡΙΒΩΣ 06:00-14:00, από τη λίστα
    // επιλεξιμότητας του 06:00 με δίκαιη εναλλαγή (απόφαση 12/07/2026).
    // ΠΡΩΤΟ στη σειρά: το pool του είναι το πιο περιορισμένο — να μην
    // «καίγονται» τα μέλη της λίστας σε άλλα slots (π.χ. Νικολιάδης σε Eurobank)
    { start: '06:00', end: '14:00', skill: null, department: null, period: null, headcount: 1, label: 'Πειραιώς', color: 'Πειραιώς' },
    { start: '07:00', end: '15:00', skill: null, department: 'supervisor', period: null, headcount: 1, label: 'Supervisor', color: 'Supervisor' },
    { start: '07:30', end: '15:30', skill: 'EUROBANK', department: 'call', period: null, headcount: 1, label: 'Eurobank', color: 'Eurobank' },
    { start: '08:00', end: '16:00', skill: 'EUROBANK', department: 'call', period: null, headcount: 1, label: 'Eurobank (μόνο)', color: 'Eurobank' },
    { start: '08:00', end: '16:00', skill: 'ALPHA', department: 'call', period: null, headcount: 2, label: 'Alpha', color: 'Υπόλοιπα call' },
    { start: '08:00', end: '16:00', skill: null, department: 'verification', period: 'morning', headcount: 1, label: 'Verification', color: 'Verification' },
    { start: '15:00', end: '23:00', skill: null, department: 'supervisor', period: null, headcount: 1, label: 'Supervisor', color: 'Supervisor' },
    { start: '15:30', end: '23:30', skill: 'EUROBANK', department: 'call', period: null, headcount: 1, label: 'Eurobank', color: 'Eurobank' },
    { start: '16:00', end: '24:00', skill: 'EUROBANK', department: 'call', period: null, headcount: 1, label: 'Eurobank (μόνο)', color: 'Eurobank' },
    { start: '16:00', end: '24:00', skill: 'ALPHA', department: 'call', period: null, headcount: 2, label: 'Alpha', color: 'Υπόλοιπα call' },
    { start: '16:00', end: '24:00', skill: 'ΠΕΙΡΑΙΩΣ', department: null, period: 'afternoon', headcount: 1, label: 'Πειραιώς', color: 'Πειραιώς' },
    { start: '16:00', end: '24:00', skill: null, department: 'verification', period: 'afternoon', headcount: 1, label: 'Verification', color: 'Verification' },
    { start: '23:00', end: '07:00', skill: 'EUROBANK', department: null, period: null, headcount: 1, label: 'Νυχτερινή Eurobank', color: 'Eurobank' }
  ]
};

// Βοηθητικό: 'HH:MM-HH:MM' → { start, end }
function splitShift(s) {
  const [start, end] = s.split('-');
  return { start, end };
}

async function seed() {
  const conn = await pool.getConnection();
  try {
    if (FORCE) {
      // Καθαρισμός ΜΟΝΟ πινάκων αναφοράς — όχι ιστορικό προγραμμάτων
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const t of ['agent_skills', 'agent_constraints', 'shift_eligibility', 'agents', 'shift_requirements', 'skills', 'roles']) {
        await conn.query(`TRUNCATE TABLE ${t}`);
      }
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
      console.log('(--force) Καθαρίστηκαν οι πίνακες αναφοράς.');
    }

    // ---- Φόρτωση seed_agents.json ----
    const seedPath = path.join(__dirname, '..', '..', 'seed_agents.json');
    const seedData = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

    // ---- 1. Ρόλοι ----
    const [[{ nRoles }]] = await conn.query('SELECT COUNT(*) AS nRoles FROM roles');
    if (nRoles === 0) {
      for (const r of ROLES) {
        await conn.query('INSERT INTO roles (name, color_argb) VALUES (?, ?)', [r.name, r.color_argb]);
      }
      console.log(`OK: ${ROLES.length} ρόλοι/χρώματα.`);
    } else {
      console.log('Ρόλοι: υπάρχουν ήδη, παραλείπονται.');
    }

    // ---- 2. Skills (από το seed file) ----
    const [[{ nSkills }]] = await conn.query('SELECT COUNT(*) AS nSkills FROM skills');
    if (nSkills === 0) {
      for (const s of seedData.skills) {
        await conn.query('INSERT INTO skills (name) VALUES (?)', [s]);
      }
      console.log(`OK: ${seedData.skills.length} δεξιότητες.`);
    } else {
      console.log('Δεξιότητες: υπάρχουν ήδη, παραλείπονται.');
    }

    // Χάρτες όνομα → id για roles και skills
    const [roleRows] = await conn.query('SELECT id, name FROM roles');
    const roleId = Object.fromEntries(roleRows.map((r) => [r.name, r.id]));
    const [skillRows] = await conn.query('SELECT id, name FROM skills');
    const skillId = Object.fromEntries(skillRows.map((s) => [s.name, s.id]));

    // ---- 3. Απαιτήσεις κάλυψης ----
    const [[{ nReq }]] = await conn.query('SELECT COUNT(*) AS nReq FROM shift_requirements');
    if (nReq === 0) {
      let count = 0;
      for (const [dayType, reqs] of Object.entries(REQUIREMENTS)) {
        for (const r of reqs) {
          await conn.query(
            `INSERT INTO shift_requirements
             (day_type, start_time, end_time, skill_id, department, period, headcount, label, role_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              dayType, r.start, r.end,
              r.skill ? skillId[r.skill] : null,
              r.department, r.period || null, r.headcount, r.label,
              r.color ? roleId[r.color] : null
            ]
          );
          count++;
        }
      }
      console.log(`OK: ${count} απαιτήσεις κάλυψης (καθημερινές + ΣΚ).`);
    } else {
      console.log('Απαιτήσεις κάλυψης: υπάρχουν ήδη, παραλείπονται.');
    }

    // ---- 4. Αρχικός χρήστης admin/admin ----
    const [[{ nUsers }]] = await conn.query('SELECT COUNT(*) AS nUsers FROM users');
    if (nUsers === 0) {
      const hash = bcrypt.hashSync('admin', 10);
      await conn.query(
        'INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)',
        ['admin', hash, 'Διαχειριστής']
      );
      console.log('OK: χρήστης admin/admin.');
    } else {
      console.log('Χρήστες: υπάρχουν ήδη, παραλείπονται.');
    }

    // ---- 5. Import agents + agent_skills + agent_constraints ----
    const [[{ nAgents }]] = await conn.query('SELECT COUNT(*) AS nAgents FROM agents');
    if (nAgents === 0) {
      let cAgents = 0;
      let cConstraints = 0;
      const agentIdByName = {};

      for (const a of seedData.agents) {
        const fixed = a.fixed_shift ? splitShift(a.fixed_shift) : null;
        const [res] = await conn.query(
          `INSERT INTO agents
           (full_name, company, departments, active, can_night, is_new,
            fixed_shift_start, fixed_shift_end, fixed_days, fixed_days_off,
            weekend_shift, work_location, notes)
           VALUES (?, ?, ?, 1, ?, 0, ?, ?, ?, ?, ?, ?, NULL)`,
          [
            a.full_name,
            a.company,
            JSON.stringify(a.departments),
            a.can_night === null || a.can_night === undefined ? null : (a.can_night ? 1 : 0),
            fixed ? fixed.start : null,
            fixed ? fixed.end : null,
            a.fixed_days ? JSON.stringify(a.fixed_days) : null,
            a.fixed_days_off ? JSON.stringify(a.fixed_days_off) : null,
            a.weekend_shift || null,
            a.work_location || null
          ]
        );
        const id = res.insertId;
        agentIdByName[a.full_name] = id;
        cAgents++;

        // Δεξιότητες του agent
        for (const s of a.skills || []) {
          if (!skillId[s]) throw new Error(`Άγνωστη δεξιότητα "${s}" στον ${a.full_name}`);
          await conn.query('INSERT INTO agent_skills (agent_id, skill_id) VALUES (?, ?)', [id, skillId[s]]);
        }

        // Το κείμενο constraints του seed → agent_constraints.description
        // (τα δομημένα πεδία day_of_week/allowed_shifts/required_shift
        //  συμπληρώνονται από τον generator/UI στα επόμενα βήματα)
        if (a.constraints) {
          await conn.query(
            'INSERT INTO agent_constraints (agent_id, description) VALUES (?, ?)',
            [id, a.constraints]
          );
          cConstraints++;
        }
      }
      console.log(`OK: ${cAgents} agents, ${cConstraints} constraints.`);

      // ---- Λίστα επιλεξιμότητας 19:00-03:00 (Κ9) ----
      let cElig = 0;
      for (const e of seedData.shift_eligibility_19_03) {
        const id = agentIdByName[e.agent];
        if (!id) throw new Error(`Άγνωστος agent στη λίστα 19:00-03:00: "${e.agent}"`);
        await conn.query(
          `INSERT INTO shift_eligibility
           (agent_id, shift_start, shift_end, max_per_week, location, not_alone, notes)
           VALUES (?, '19:00', '03:00', ?, ?, ?, ?)`,
          [id, e.max_per_week, e.location, e.not_alone ? 1 : 0, e['σημείωση'] || null]
        );
        cElig++;
      }
      console.log(`OK: ${cElig} εγγραφές επιλεξιμότητας 19:00-03:00.`);
    } else {
      console.log('Agents: υπάρχουν ήδη, παραλείπονται (τρέξε με --force για επανεισαγωγή).');
    }

    console.log('Seed ολοκληρώθηκε.');
  } finally {
    conn.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('Σφάλμα seed:', err.message);
  process.exit(1);
});
