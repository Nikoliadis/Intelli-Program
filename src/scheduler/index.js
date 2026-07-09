// Δημόσιο interface του scheduler — απομονωμένο ώστε να μπορεί μελλοντικά
// να αντικατασταθεί (π.χ. CP-SAT service) χωρίς αλλαγές στα routes.
//
//   generatePeriod(weeks) → { weeks: [{weekStart, dates, assignments, report}], finalState }
//
// weeks: [{start:'YYYY-MM-DD' (Δευτέρα), end:'YYYY-MM-DD' (Κυριακή)}] ΜΕ ΤΗ ΣΕΙΡΑ.
// Η κατάσταση (συνεχόμενες μέρες, λήξη τελευταίας βάρδιας, μετρητές Σ3)
// μεταφέρεται εβδομάδα σε εβδομάδα· πριν την πρώτη φορτώνεται η τελευταία
// αποθηκευμένη εβδομάδα από τη βάση (αν υπάρχει).
const { loadContext } = require('./context');
const { generateWeek } = require('./engine');

async function generatePeriod(weeks) {
  if (!Array.isArray(weeks) || weeks.length === 0) {
    throw new Error('Δεν δόθηκαν εβδομάδες');
  }
  const ctx = await loadContext(weeks[0].start, weeks[weeks.length - 1].end);

  // Βαθύ αντίγραφο αρχικής κατάστασης (από την τελευταία αποθηκευμένη εβδομάδα)
  let state = JSON.parse(JSON.stringify(ctx.initialState || {}));

  const out = [];
  for (const wk of weeks) {
    const res = generateWeek(ctx, wk.start, state);
    state = res.nextState;
    out.push({
      weekStart: res.weekStart,
      dates: res.dates,
      assignments: res.assignments,
      report: res.report
    });
  }
  return { weeks: out, finalState: state };
}

module.exports = { generatePeriod };
