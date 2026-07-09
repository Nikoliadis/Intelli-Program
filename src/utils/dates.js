// Βοηθητικά ημερομηνιών. Δουλεύουμε ΠΑΝΤΑ με strings 'YYYY-MM-DD' προς τα
// έξω ώστε να μην μπλέκουν ζώνες ώρας — τα Date objects μόνο εσωτερικά.

// 'YYYY-MM-DD' → Date (τοπική ώρα, μεσημέρι για ασφάλεια από DST)
function parse(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

// Date → 'YYYY-MM-DD'
function fmt(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Πρόσθεση ημερών σε 'YYYY-MM-DD'
function addDays(dateStr, days) {
  const d = parse(dateStr);
  d.setDate(d.getDate() + days);
  return fmt(d);
}

// Η Δευτέρα της εβδομάδας που περιέχει την ημερομηνία
function mondayOf(dateStr) {
  const d = parse(dateStr);
  const dow = d.getDay(); // 0=Κυριακή ... 6=Σάββατο
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return fmt(d);
}

// Ημέρα εβδομάδας 1=Δευτέρα ... 7=Κυριακή (όπως στο seed)
function dayOfWeek(dateStr) {
  const dow = parse(dateStr).getDay();
  return dow === 0 ? 7 : dow;
}

// Στρογγυλοποίηση περιόδου σε πλήρεις εβδομάδες Δευτέρα-Κυριακή που την
// καλύπτουν (π.χ. Ιούλιος 2026 → 29/6 έως 2/8). Επιστρέφει λίστα εβδομάδων.
function weeksCovering(fromStr, toStr) {
  const firstMonday = mondayOf(fromStr);
  const lastMonday = mondayOf(toStr);
  const weeks = [];
  let w = firstMonday;
  while (w <= lastMonday) {
    weeks.push({ start: w, end: addDays(w, 6) });
    w = addDays(w, 7);
  }
  return weeks;
}

// Όρια μήνα 'YYYY-MM' → { from, to }
function monthBounds(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate(); // ημέρα 0 του επόμενου = τελευταία του μήνα
  const to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(s) {
  if (!DATE_RE.test(s)) return false;
  return fmt(parse(s)) === s; // απορρίπτει π.χ. 2026-02-31
}

module.exports = { parse, fmt, addDays, mondayOf, dayOfWeek, weeksCovering, monthBounds, isValidDate };
