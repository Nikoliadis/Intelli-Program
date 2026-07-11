// Δημόσιο interface του scheduler — απομονωμένο ώστε να μπορεί μελλοντικά
// να αντικατασταθεί (π.χ. CP-SAT service) χωρίς αλλαγές στα routes.
//
//   generatePeriod(weeks) → { weeks: [{weekStart, dates, assignments, report}], finalState }
//
// weeks: [{start:'YYYY-MM-DD' (Δευτέρα), end:'YYYY-MM-DD' (Κυριακή)}] ΜΕ ΤΗ ΣΕΙΡΑ.
// Η κατάσταση (συνεχόμενες μέρες, λήξη τελευταίας βάρδιας, μετρητές Σ3)
// μεταφέρεται εβδομάδα σε εβδομάδα· πριν την πρώτη φορτώνεται η τελευταία
// αποθηκευμένη εβδομάδα από τη βάση (αν υπάρχει).
const pool = require('../db/pool');
const { loadContext } = require('./context');
const { generateWeek } = require('./engine');
const { addDays } = require('../utils/dates');

async function generatePeriod(weeks) {
  if (!Array.isArray(weeks) || weeks.length === 0) {
    throw new Error('Δεν δόθηκαν εβδομάδες');
  }
  const ctx = await loadContext(weeks[0].start, weeks[weeks.length - 1].end);
  // Lazy require για αποφυγή κυκλικού import (validate → engine)
  const { computeStateFromAssignments } = require('./validate');

  // Βαθύ αντίγραφο αρχικής κατάστασης (από την τελευταία αποθηκευμένη εβδομάδα)
  let state = JSON.parse(JSON.stringify(ctx.initialState || {}));

  // Προ-φόρτωση ΟΛΩΝ των εισηγμένων εβδομάδων της περιόδου — χρειάζονται
  // και για να «βλέπει» η ΠΡΟΗΓΟΥΜΕΝΗ εβδομάδα προς τα εμπρός (Κ10)
  const importedByStart = new Map();
  for (const wk of weeks) {
    const [rows] = await pool.query(
      'SELECT data FROM schedules WHERE week_start = ? ORDER BY id DESC LIMIT 1',
      [wk.start]
    );
    if (rows[0]) {
      try {
        const data = JSON.parse(rows[0].data);
        if (data.report && data.report.imported) importedByStart.set(wk.start, data);
      } catch { /* αγνόησέ το */ }
    }
  }

  const out = [];
  for (const wk of weeks) {
    // Εβδομάδα ΕΙΣΗΓΜΕΝΗ από Excel (πρόγραμμα που έχει ήδη βγει) =
    // δεδομένη πραγματικότητα: ΔΕΝ ξαναπαράγεται — κρατιέται ως έχει και η
    // κατάστασή της (συνεχόμενες μέρες Κ10, λήξεις Κ8, μετρητές) τροφοδοτεί
    // τις επόμενες εβδομάδες (13/07/2026: «ποιος δούλεψε 5 σερί → ρεπό Δευτέρα»)
    const importedData = importedByStart.get(wk.start);

    if (importedData) {
      state = await computeStateFromAssignments(wk.start, importedData.assignments, state);
      const dates = [];
      for (let i = 0; i < 7; i++) dates.push(addDays(wk.start, i));
      out.push({
        weekStart: wk.start,
        dates,
        assignments: importedData.assignments,
        report: {
          imported: true,
          uncovered: [],
          soft: [],
          notes: ['Εισηγμένη από Excel — κρατήθηκε ως έχει, δεν ξαναπαράχθηκε.']
        },
        state
      });
      continue;
    }

    // Αν η ΕΠΟΜΕΝΗ εβδομάδα είναι εισηγμένη (γνωστή/κλειδωμένη), υπολόγισε
    // πόσες συνεχόμενες μέρες δουλεύει κάθε agent στην αρχή της — ώστε η
    // τρέχουσα να μην τον φορτώσει μέχρι την Κυριακή και βγει 6ήμερο
    const nextImported = importedByStart.get(addDays(wk.start, 7));
    let nextLead = null;
    if (nextImported) {
      nextLead = new Map();
      const workSet = new Set(
        nextImported.assignments.filter((a) => !a.off).map((a) => `${a.agentId}|${a.date}`)
      );
      for (const ag of ctx.agents) {
        let n = 0;
        for (let j = 0; j < 7; j++) {
          const date = addDays(wk.start, 7 + j);
          const t = ctx.timeOff.get(`${ag.id}|${date}`);
          if (workSet.has(`${ag.id}|${date}`) || t === 'leave' || t === 'sick') n++;
          else break;
        }
        if (n > 0) nextLead.set(ag.id, n);
      }
    }

    const res = generateWeek(ctx, wk.start, state, { nextLead });
    state = res.nextState;
    out.push({
      weekStart: res.weekStart,
      dates: res.dates,
      assignments: res.assignments,
      report: res.report,
      // Κατάσταση στο ΤΕΛΟΣ της εβδομάδας — αποθηκεύεται μαζί της ώστε οι
      // επόμενες παραγωγές να ελέγχουν σωστά Κ8/Κ10 στο ξεκίνημά τους
      state: res.nextState
    });
  }
  return { weeks: out, finalState: state };
}

module.exports = { generatePeriod };
