// Βοηθητικά χρόνου για τον generator. Όλες οι στιγμές εκφράζονται σε
// «απόλυτα λεπτά» = dayNumber * 1440 + λεπτά ημέρας, όπου dayNumber =
// ημέρες από 1/1/1970 (UTC αριθμητική πάνω σε strings 'YYYY-MM-DD', ώστε
// να μην επηρεάζει η ζώνη ώρας). Έτσι οι έλεγχοι Κ8/Κ10 δουλεύουν σωστά
// και στα σύνορα εβδομάδων.

// 'HH:MM' → λεπτά ημέρας (δέχεται και '24:00' = 1440)
function toMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// 'YYYY-MM-DD' → αριθμός ημέρας από 1/1/1970
function dayNum(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

// Απόλυτα λεπτά έναρξης/λήξης βάρδιας στην ημερομηνία date.
// Αν η λήξη είναι <= της έναρξης (π.χ. 19:00-03:00, 23:00-07:00), η βάρδια
// περνά στην επόμενη μέρα.
function shiftAbs(dateStr, start, end) {
  const base = dayNum(dateStr) * 1440;
  const s = toMin(start);
  let e = toMin(end);
  if (e <= s) e += 1440;
  return { startAbs: base + s, endAbs: base + e };
}

// Πρωινή βάρδια: ξεκινά 05:00-11:59 και δεν περνά μεσάνυχτα
function isMorning(start, end) {
  const s = toMin(start);
  return s >= 300 && s < 720 && toMin(end) > s;
}

// Απογευματινή: ξεκινά 12:00-18:59
function isAfternoon(start) {
  const s = toMin(start);
  return s >= 720 && s < 1140;
}

// Νυχτερινή: ξεκινά 23:00 ή αργότερα και περνά στην επόμενη μέρα
function isNight(start, end) {
  return toMin(start) >= 1380 && toMin(end) <= toMin(start);
}

module.exports = { toMin, dayNum, shiftAbs, isMorning, isAfternoon, isNight };
