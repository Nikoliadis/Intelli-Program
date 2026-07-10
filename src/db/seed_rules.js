// ΒΗΜΑ 4: Δομημένοι (μηχανικά αναγνώσιμοι) κανόνες ανά agent.
// Προσθέτει στήλη `rule` (JSON) στον πίνακα agent_constraints και γράφει
// για κάθε agent τους κανόνες που προκύπτουν από το πεδίο constraints του
// seed_agents.json + τις αποφάσεις του προϊσταμένου (09/07/2026):
//   - Νικολιάδης & Νικολιάδη Αλίκη: αποκτούν skill ΠΕΙΡΑΙΩΣ (για Σ1/Πειραιώς)
//   - Νυχτερινές: μόνο Νομικού + Μαυραγάνη (Μαυραγάνη τελευταία επιλογή)
//   - ΟΛΟΙ οι ενεργοί προγραμματίζονται 5 εργάσιμες + 2 ρεπό (Κ2)
//
// Εκτελείται με: node src/db/seed_rules.js  (idempotent — σβήνει και
// ξαναγράφει ΜΟΝΟ τους κανόνες των agents του παρακάτω χάρτη)
const pool = require('./pool');

// Λεξιλόγιο τύπων κανόνων που καταλαβαίνει ο generator (src/scheduler):
//   only_morning {starts?}      μόνο πρωινή βάρδια (προαιρετικά επιτρεπτές ώρες έναρξης)
//   only_afternoon              μόνο απογευματινή βάρδια
//   allowed_shifts {shifts}     αποκλειστική λίστα επιτρεπτών ωραρίων
//   day_off_or_telework {days, shift}  τις μέρες αυτές: ρεπό Ή τηλεργασία στο ωράριο
//   split_shift {days, parts}   σπαστό ωράριο τις συγκεκριμένες μέρες (αλλιώς ρεπό)
//   weekly_alternation          εναλλαγή πρωί/απόγευμα ανά εβδομάδα
//   weekdays_only               δουλεύει μόνο καθημερινές
//   morning_start_after {time}  αν πρωί, έναρξη όχι νωρίτερα από time
//   start_after {time}          κάθε βάρδια ξεκινά από time και μετά
//   end_by {time}               κάθε βάρδια τελειώνει το αργότερο time
//   telework_days {count}       Χ μέρες τηλεργασία την εβδομάδα
//   afternoon_shift_international {shift}  όταν απογευματινή διά ζώσης: αυτό το ωράριο, International
//   afternoon_office_shift {shift}  απογευματινή από γραφείο ΜΟΝΟ με αυτό το ωράριο
//   night_last_resort           νυχτερινή μόνο αν δεν υπάρχει άλλος (soft)
//   skill_last_resort {skill}   το skill μόνο σε απόλυτη ανάγκη (soft)
//   prefer_morning / prefer_afternoon  (soft)
//   consecutive_off_strong      συνεχόμενα ρεπό με αυξημένη προτεραιότητα (soft)
//   pair_same_start {with}      ίδια ώρα έναρξης με άλλον agent (soft)
//   friday_piraeus_pair {with}  Σ1: Παρασκευή 06:00-14:00 Πειραιώς μαζί (soft)
//   heron_weekdays              τις καθημερινές ΗΡΩΝ (ετικέτα/χρώμα)

const RULES = {
  'ΡΙΖΟΥ ΒΙΚΥ': [
    { d: 'Εναλλαγή βάρδιας κάθε εβδομάδα: μία εβδομάδα πρωί, μία απόγευμα (λόγω 2ης εργασίας).', r: { type: 'weekly_alternation' } }
  ],
  'ΚΡΑΣΑΔΑΚΗ ΣΟΦΙΑ': [
    { d: 'Μόνο πρωινή βάρδια. Εξυπηρετεί ΑΠΕΔ τις καθημερινές.', r: { type: 'only_morning' } }
  ],
  'ΜΑΥΡΑΓΑΝΗ ΝΙΚΟΛΕΤΑ': [
    { d: 'Νυχτερινή (23:00-07:00) ΜΟΝΟ αν είναι ανάγκη — τελευταία επιλογή.', r: { type: 'night_last_resort' } }
  ],
  'ΝΙΚΟΛΙΑΔΗΣ ΝΙΚΟΣ': [
    { d: 'ΜΟΝΟ πρωινή βάρδια, όλες τις μέρες (hard).', r: { type: 'only_morning' } },
    { d: 'Λόγω σχολής: κάθε Δευτέρα και Παρασκευή ρεπό Ή τηλεργασία 06:00-14:00.', r: { type: 'day_off_or_telework', days: [1, 5], shift: ['06:00', '14:00'] } },
    { d: 'Soft: Παρασκευή 06:00-14:00 Πειραιώς μαζί με Νικολιάδη Αλίκη, αλλιώς ρεπό ο ένας.', r: { type: 'friday_piraeus_pair', with: 'ΝΙΚΟΛΙΑΔΗ ΑΛΙΚΗ' } },
    { d: 'Soft: ίδια ώρα έναρξης με Νικολιάδη Αλίκη (έρχονται μαζί).', r: { type: 'pair_same_start', with: 'ΝΙΚΟΛΙΑΔΗ ΑΛΙΚΗ' } }
  ],
  'ΝΟΜΙΚΟΥ ΝΟΤΑ': [
    { d: 'Προτιμά απογευματινή βάρδια (2η εργασία). Κάνει κανονικά νυχτερινή 23:00-07:00.', r: { type: 'prefer_afternoon' } }
  ],
  'ΜΠΑΚΟΥΛΗΣ ΠΑΝΑΓΙΩΤΗΣ': [
    { d: '2 ημέρες τηλεργασία + 3 ημέρες γραφείο την εβδομάδα.', r: { type: 'telework_days', count: 2 } },
    { d: 'Όταν κάνει απογευματινή διά ζώσης: 15:30-23:30 και International.', r: { type: 'afternoon_shift_international', shift: ['15:30', '23:30'] } }
  ],
  'ΓΙΩΤΗ ΔΗΜΗΤΡΑ': [
    { d: 'Πρωινή ή απογευματινή — το αργότερο έως 23:30.', r: { type: 'end_by', time: '23:30' } }
  ],
  'ΔΕΛΗΚΩΣΤΟΠΟΥΛΟΥ ΠΑΝΑΓΙΩΤΑ': [
    { d: 'Απογευματινή από γραφείο ΜΟΝΟ ωράριο 14:00-22:00.', r: { type: 'afternoon_office_shift', shift: ['14:00', '22:00'] } },
    { d: 'Κυρίως ΗΡΩΝ — Eurobank ΜΟΝΟ σε απόλυτη ανάγκη (10/07/2026: μόνο αν δεν βγαίνει αλλιώς).', r: { type: 'skill_last_resort', skill: 'EUROBANK' } },
    { d: 'Κυρίως ΗΡΩΝ τις καθημερινές (10/07/2026).', r: { type: 'heron_weekdays' } }
  ],
  'ΧΑΛΑΣΤΑΝΗ ΟΛΓΑ': [
    { d: 'Προτιμά πρωινή βάρδια (λόγω equites). Δεν κάνει αγγλικά calls.', r: { type: 'prefer_morning' } }
  ],
  'ΠΑΥΛΟΥ ΝΙΚΟΣ': [
    { d: 'ΜΟΝΟ απογευματινή 15:30-23:30 ή 16:00-24:00 (2η εργασία). Η 19:00-03:00 επιτρέπεται μέσω λίστας Κ9.', r: { type: 'allowed_shifts', shifts: [['15:30', '23:30'], ['16:00', '24:00']] } }
  ],
  'ΜΠΟΥΓΙΟΥΚΟΣ ΓΙΩΡΓΟΣ': [
    { d: 'Αν μπαίνει πρωί, από 09:00 και μετά.', r: { type: 'morning_start_after', time: '09:00' } },
    { d: 'Απογευματινή έως 23:30 — την προτιμά.', r: { type: 'end_by', time: '23:30' } },
    { d: 'Προτιμά απογευματινή.', r: { type: 'prefer_afternoon' } }
  ],
  'ΑΔΡΑΚΤΑ ΕΥΓΕΝΙΑ': [
    { d: 'Απόγευμα έως 22:00.', r: { type: 'end_by', time: '22:00' } },
    { d: 'Πρωί από 09:00 κυρίως (μπορεί και 08:00).', r: { type: 'morning_start_after', time: '08:00' } }
  ],
  'ΝΙΚΟΛΙΑΔΗ ΑΛΙΚΗ': [
    { d: 'ΜΟΝΟ πρωινή βάρδια, όλες τις μέρες, με έναρξη 07:30 ή 08:00 (hard).', r: { type: 'only_morning', starts: ['07:30', '08:00'] } },
    { d: 'Λόγω σχολής: κάθε Τρίτη και Παρασκευή ρεπό Ή τηλεργασία 06:00-14:00.', r: { type: 'day_off_or_telework', days: [2, 5], shift: ['06:00', '14:00'] } },
    { d: 'Soft: ίδια ώρα έναρξης με τον Νικολιάδη Νίκο (έρχονται μαζί).', r: { type: 'pair_same_start', with: 'ΝΙΚΟΛΙΑΔΗΣ ΝΙΚΟΣ' } }
  ],
  'ΠΑΠΑΣΑΡΑΝΤΟΥ ΜΑΤΙΝΑ': [
    { d: 'Προτιμάει συνεχόμενα ρεπό (soft με αυξημένη προτεραιότητα).', r: { type: 'consecutive_off_strong' } }
  ],
  'ΗΛΙΟΠΟΥΛΟΣ ΣΩΤΗΡΗΣ': [
    { d: 'ΗΡΩΝ Δευτέρα έως Παρασκευή.', r: { type: 'heron_weekdays' } }
  ],
  'ΠΑΝΑΓΟΥ ΔΕΣΠΟΙΝΑ': [
    { d: 'Δευτέρα έως Παρασκευή ΗΡΩΝ — μόνο καθημερινές.', r: { type: 'weekdays_only' } },
    { d: 'ΗΡΩΝ.', r: { type: 'heron_weekdays' } }
  ],
  'ΚΟΥΛΟΓΙΑΝΝΗΣ ΚΥΡΙΑΚΟΣ': [
    { d: 'Τις καθημερινές: σπαστό ωράριο 09:00-14:00 + 21:00-24:00 (ΣΚ ρεπό). Σημ.: το σπαστό συνεπάγεται 9 ώρες ανάπαυση 24:00→09:00 — αποδεκτή εξαίρεση του Κ8 βάσει του δηλωμένου σταθερού ωραρίου (Κ5).', r: { type: 'split_shift', days: [1, 2, 3, 4, 5], parts: [['09:00', '14:00'], ['21:00', '24:00']] } }
  ],
  'ΚΟΨΙΑ ΒΑΣΙΑ': [
    { d: 'Έναρξη βάρδιας από 09:00 και μετά.', r: { type: 'start_after', time: '09:00' } },
    { d: 'ΗΡΩΝ Δευτέρα έως Παρασκευή — μόνο καθημερινές.', r: { type: 'weekdays_only' } },
    { d: 'ΗΡΩΝ.', r: { type: 'heron_weekdays' } }
  ],
  'ΟΙΚΟΝΟΜΟΠΟΥΛΟΥ ΜΑΡΙΑ': [
    { d: 'Εξ αποστάσεως (τηλεργασία), ΜΟΝΟ πρωινά.', r: { type: 'only_morning' } }
  ],
  'ΤΣΙΤΣΙΚΩΣΤΑΣ ΑΛΕΞΑΝΔΡΟΣ': [
    { d: 'Σταθερά ρεπό Τετάρτη + Πέμπτη. Τις υπόλοιπες μέρες απογευματινή βάρδια. Απόφαση 09/07/2026: ΔΕΝ μπαίνει σε νυχτερινή 23:00-07:00.', r: { type: 'only_afternoon' } }
  ],
  'ΠΑΠΑΣΑΡΑΝΤΟΥ ΚΩΝΣΤΑΝΤΙΝΑ': [
    { d: 'Εξ αποστάσεως (τηλεργασία), ΜΟΝΟ πρωινά.', r: { type: 'only_morning' } }
  ],
  'ΠΡΑΠΑ ΠΑΡΑΣΚΕΥΗ': [
    { d: 'Κυρίως Πειραιώς — προτιμά πρωί.', r: { type: 'prefer_morning' } },
    { d: 'Απόγευμα (δεν προτιμάται) το πολύ μέχρι 21:00.', r: { type: 'end_by', time: '21:00' } }
  ]
};

// Skill ΠΕΙΡΑΙΩΣ στους δύο Νικολιάδη (απόφαση προϊσταμένου 09/07/2026)
const ADD_SKILLS = [
  { agent: 'ΝΙΚΟΛΙΑΔΗΣ ΝΙΚΟΣ', skill: 'ΠΕΙΡΑΙΩΣ' },
  { agent: 'ΝΙΚΟΛΙΑΔΗ ΑΛΙΚΗ', skill: 'ΠΕΙΡΑΙΩΣ' }
];

async function run() {
  const conn = await pool.getConnection();
  try {
    // 1. Στήλη rule (JSON) αν δεν υπάρχει
    const [cols] = await conn.query(
      `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_constraints' AND COLUMN_NAME = 'rule'`
    );
    if (cols[0].n === 0) {
      await conn.query('ALTER TABLE agent_constraints ADD COLUMN rule JSON NULL');
      console.log('OK: προστέθηκε στήλη agent_constraints.rule');
    }

    // 2. Skill ΠΕΙΡΑΙΩΣ στους Νικολιάδη/Νικολιάδη Αλίκη
    for (const { agent, skill } of ADD_SKILLS) {
      const [r] = await conn.query(
        `INSERT IGNORE INTO agent_skills (agent_id, skill_id)
         SELECT a.id, s.id FROM agents a, skills s WHERE a.full_name = ? AND s.name = ?`,
        [agent, skill]
      );
      if (r.affectedRows) console.log(`OK: skill ${skill} → ${agent}`);
    }

    // 3. Δομημένοι κανόνες: σβήσιμο & επανεγγραφή ΜΟΝΟ για τους agents του χάρτη
    let total = 0;
    for (const [name, rules] of Object.entries(RULES)) {
      const [[agent]] = await conn.query('SELECT id FROM agents WHERE full_name = ?', [name]);
      if (!agent) {
        console.warn(`ΠΡΟΣΟΧΗ: δεν βρέθηκε agent "${name}" — παραλείπεται`);
        continue;
      }
      await conn.query('DELETE FROM agent_constraints WHERE agent_id = ?', [agent.id]);
      for (const { d, r } of rules) {
        await conn.query(
          'INSERT INTO agent_constraints (agent_id, description, rule) VALUES (?, ?, ?)',
          [agent.id, d, JSON.stringify(r)]
        );
        total++;
      }
    }
    console.log(`OK: ${total} δομημένοι κανόνες για ${Object.keys(RULES).length} agents.`);
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((e) => {
  console.error('Σφάλμα:', e.message);
  process.exit(1);
});
