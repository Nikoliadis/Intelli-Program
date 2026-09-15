// Στοχευμένη εγκατάσταση ΜΟΝΟ των κανόνων της 05/09/2026 για τρεις
// εργαζομένους — ΧΩΡΙΣ να πειράξει τίποτε άλλο στη βάση.
//
// Σε αντίθεση με το src/db/seed_rules.js (που σβήνει και ξαναγράφει τους
// κανόνες ΟΛΩΝ των agents του χάρτη του, και πειράζει skills/λίστες), αυτό
// το script:
//   * αγγίζει ΜΟΝΟ τους τρεις παρακάτω εργαζομένους
//   * από αυτούς σβήνει ΜΟΝΟ τον προηγούμενο κανόνα ΙΔΙΟΥ ΤΥΠΟΥ (ώστε να
//     μπορεί να ξανατρέξει χωρίς διπλοεγγραφές) — οι υπόλοιποι κανόνες τους
//     μένουν ανέπαφοι
//   * ΔΕΝ αλλάζει skills, λίστες επιλεξιμότητας, active, can_night ή
//     οτιδήποτε άλλο — απλώς αναφέρει τι βρήκε
//
// Χρήση (τοπικά):
//   node scripts/add_shift_rules.js
// Χρήση (Railway — βάλε το MYSQL_PUBLIC_URL από τις Variables του MySQL):
//   DATABASE_URL="mysql://root:XXXX@host.proxy.rlwy.net:12345/railway" node scripts/add_shift_rules.js
//
// Πρόσθεσε --dry-run για να δεις τι ΘΑ έκανε, χωρίς καμία εγγραφή.
const pool = require('../src/db/pool');
const cfg = require('../src/db/config');

const DRY = process.argv.includes('--dry-run');

const RULES = {
  'ALIGIA LORENTSO': [
    {
      d: 'Προτιμώνται ΠΡΩΙΝΕΣ και ΒΡΑΔΙΝΕΣ βάρδιες (έναρξη 19:00 και μετά — 19:00-03:00, νυχτερινή)· οι απογευματινές όσο το δυνατόν λιγότερες. SOFT προτίμηση κατανομής — δεν αποκλείει την απογευματινή όταν το απαιτεί η κάλυψη (05/09/2026).',
      r: { type: 'prefer_morning_evening' }
    }
  ],
  'ΑΓΓΛΟΓΑΛΛΟΣ ΠΑΤΑΠΙΟΣ': [
    {
      d: 'ΑΠΟΚΛΕΙΣΤΙΚΑ οι βάρδιες 15:30-23:30, 16:00-24:00 και 23:00-07:00 — καμία άλλη, καμία μέρα (hard, 05/09/2026).',
      r: { type: 'allowed_shifts', strict: true, shifts: [['15:30', '23:30'], ['16:00', '24:00'], ['23:00', '07:00']] }
    }
  ],
  'ΙΩΑΝΝΑ ΚΑΛΑΦΑΤΗ': [
    {
      d: 'Λόγω σχολείου: ΑΠΟΚΛΕΙΣΤΙΚΑ οι βάρδιες 07:30-15:30, 08:00-16:00 και 23:00-07:00 — καμία άλλη, καμία μέρα (hard, 05/09/2026).',
      r: { type: 'allowed_shifts', strict: true, shifts: [['07:30', '15:30'], ['08:00', '16:00'], ['23:00', '07:00']] }
    }
  ]
};

// Εναλλακτικές γραφές ονόματος (σειρά επωνύμου/μικρού, τόνοι) ώστε να
// βρεθεί ο εργαζόμενος όπως κι αν είναι καταχωρημένος στη βάση
const norm = (s) => String(s).toUpperCase().replace(/[΄']/g, '').replace(/\s+/g, ' ').trim();
const sortedKey = (s) => norm(s).split(' ').sort().join(' ');

async function findAgent(conn, name) {
  const [[exact]] = await conn.query('SELECT id, full_name, active, can_night FROM agents WHERE full_name = ?', [name]);
  if (exact) return exact;
  // Ίδιες λέξεις με άλλη σειρά (π.χ. «ΚΑΛΑΦΑΤΗ ΙΩΑΝΝΑ» ↔ «ΙΩΑΝΝΑ ΚΑΛΑΦΑΤΗ»)
  const [all] = await conn.query('SELECT id, full_name, active, can_night FROM agents');
  const want = sortedKey(name);
  const hits = all.filter((a) => sortedKey(a.full_name) === want);
  if (hits.length === 1) return hits[0];
  // Μοναδικό ταίριασμα με το πρώτο «ασυνήθιστο» token (επώνυμο)
  const token = norm(name).split(' ').sort((x, y) => y.length - x.length)[0];
  const t = all.filter((a) => norm(a.full_name).split(' ').includes(token));
  return t.length === 1 ? t[0] : null;
}

async function run() {
  console.log(`Βάση: ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}${DRY ? '   [DRY-RUN — καμία εγγραφή]' : ''}\n`);
  const conn = await pool.getConnection();
  try {
    const [cols] = await conn.query(
      `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_constraints' AND COLUMN_NAME = 'rule'`
    );
    if (cols[0].n === 0) {
      console.error('ΣΦΑΛΜΑ: λείπει η στήλη agent_constraints.rule — τρέξε πρώτα: node src/db/seed_rules.js');
      process.exitCode = 1;
      return;
    }

    let missing = 0;
    for (const [name, rules] of Object.entries(RULES)) {
      const agent = await findAgent(conn, name);
      if (!agent) {
        console.log(`✗ ${name}: ΔΕΝ ΒΡΕΘΗΚΕ στη βάση — παραλείπεται (φτιάξ' τον πρώτα από τη σελίδα Εργαζομένων)`);
        missing++;
        continue;
      }
      const label = agent.full_name === name ? name : `${name}  →  βρέθηκε ως "${agent.full_name}"`;
      console.log(`• ${label}  (id=${agent.id}, active=${agent.active}, can_night=${agent.can_night})`);

      const types = new Set(rules.map((x) => x.r.type));
      const [existing] = await conn.query('SELECT id, rule FROM agent_constraints WHERE agent_id = ?', [agent.id]);
      const stale = existing.filter((row) => {
        if (!row.rule) return false;
        try {
          const r = typeof row.rule === 'string' ? JSON.parse(row.rule) : row.rule;
          return types.has(r.type);
        } catch { return false; }
      });
      const kept = existing.length - stale.length;

      if (!DRY) {
        for (const s of stale) await conn.query('DELETE FROM agent_constraints WHERE id = ?', [s.id]);
        for (const { d, r } of rules) {
          await conn.query(
            'INSERT INTO agent_constraints (agent_id, description, rule) VALUES (?, ?, ?)',
            [agent.id, d, JSON.stringify(r)]
          );
        }
      }
      console.log(`    ${stale.length ? `αντικαταστάθηκε ${stale.length} παλιός κανόνας ίδιου τύπου, ` : ''}γράφτηκαν ${rules.length}, έμειναν ανέπαφοι ${kept} άλλοι κανόνες του`);

      // Προειδοποιήσεις — ΔΕΝ αλλάζονται αυτόματα
      if (!agent.active) {
        console.log('    ⚠ ΑΝΕΝΕΡΓΟΣ: δεν θα μπει σε πρόγραμμα όσο είναι ανενεργός');
      }
      const needsNight = rules.some((x) => (x.r.shifts || []).some(([s]) => s === '23:00'));
      if (needsNight && !agent.can_night) {
        console.log('    ⚠ can_night = 0: η βάρδια 23:00-07:00 ΔΕΝ θα του/της ανατεθεί ποτέ (Κ7). Άνοιξε το «κάνει βράδυ» από τη σελίδα Εργαζομένων αν το θέλεις.');
      }
    }

    console.log(`\n${DRY ? 'DRY-RUN: δεν γράφτηκε τίποτα.' : 'Έτοιμο.'} ${missing ? `${missing} εργαζόμενος/οι δεν βρέθηκαν.` : ''}`);
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((e) => {
  console.error('Σφάλμα:', e.message);
  process.exit(1);
});
