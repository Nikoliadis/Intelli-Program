// Live έλεγχος κανόνων για χειροκίνητες αλλαγές (ΒΗΜΑ 5).
// Παίρνει τις αναθέσεις μιας εβδομάδας ΟΠΩΣ έχουν διαμορφωθεί (μετά από
// χειροκίνητες αλλαγές) και τις γειτονικές εβδομάδες, και επιστρέφει:
//   warnings:  παραβιάσεις κανόνων (προειδοποίηση — ΔΕΝ μπλοκάρουν)
//   uncovered: ακάλυπτες απαιτήσεις (κόκκινη ένδειξη στο UI)
// Οι έλεγχοι Κ8/Κ10 κοιτούν ΚΑΙ προς τις γειτονικές εβδομάδες.
const { loadContext } = require('./context');
const { shiftAllowedByRules, rule, deptMatch, REST_MIN, REST_MIN_SPLIT, MAX_STREAK } = require('./engine');
const { shiftAbs, toMin, dayNum, isMorning, isAfternoon } = require('./time');
const { addDays, dayOfWeek } = require('../utils/dates');

// Ενοποίηση αναθέσεων ίδιου agent+μέρας (σπαστό) σε ένα χρονικό διάστημα
function mergeSpans(assignments) {
  const map = new Map(); // agentId|date → {agentId, date, startAbs, endAbs, rows}
  for (const a of assignments || []) {
    if (a.off) continue;
    const abs = shiftAbs(a.date, a.start, a.end);
    const key = `${a.agentId}|${a.date}`;
    const cur = map.get(key);
    if (cur) {
      cur.startAbs = Math.min(cur.startAbs, abs.startAbs);
      cur.endAbs = Math.max(cur.endAbs, abs.endAbs);
      cur.rows.push(a);
    } else {
      map.set(key, { agentId: a.agentId, date: a.date, ...abs, rows: [a] });
    }
  }
  return map;
}

function isNightRow(a) {
  return (a.start === '23:00' || a.start === '23:30') && toMin(a.end) < toMin(a.start);
}

async function validateWeek({ weekStart, assignments, prevAssignments, prevState, nextAssignments }) {
  const weekEnd = addDays(weekStart, 6);
  const ctx = await loadContext(weekStart, weekEnd);
  const agentById = new Map(ctx.agents.map((a) => [a.id, a]));
  const dates = [];
  for (let i = 0; i < 7; i++) dates.push(addDays(weekStart, i));

  const warnings = [];
  const uncovered = [];
  const warn = (text, date) => warnings.push({ date: date || null, text });

  const work = (assignments || []).filter((a) => !a.off);
  const offs = (assignments || []).filter((a) => a.off);

  // ---------- Κ2: 1 βάρδια/μέρα, μέγιστο 5 εργάσιμες ----------
  const byAgentDate = new Map();
  for (const a of work) {
    const k = `${a.agentId}|${a.date}`;
    if (!byAgentDate.has(k)) byAgentDate.set(k, []);
    byAgentDate.get(k).push(a);
  }
  for (const [k, rows] of byAgentDate) {
    if (rows.length > 1) {
      const ag = agentById.get(rows[0].agentId);
      const sp = ag && rule(ag, 'split_shift');
      const isSplitPair = sp && rows.length === 2 &&
        rows.some((r) => r.start === sp.parts[0][0] && r.end === sp.parts[0][1]) &&
        rows.some((r) => r.start === sp.parts[1][0] && r.end === sp.parts[1][1]);
      if (!isSplitPair) {
        warn(`Κ2: ${ag ? ag.name : rows[0].agentId} έχει ${rows.length} βάρδιες την ίδια μέρα`, rows[0].date);
      }
    }
    // Βάρδια πάνω σε μέρα ρεπό/άδειας
    if (offs.some((o) => `${o.agentId}|${o.date}` === k)) {
      const ag = agentById.get(rows[0].agentId);
      warn(`${ag ? ag.name : ''}: βάρδια σε μέρα που έχει δηλωθεί ρεπό/άδεια`, rows[0].date);
    }
  }
  const workDatesByAgent = new Map();
  for (const a of work) {
    if (!workDatesByAgent.has(a.agentId)) workDatesByAgent.set(a.agentId, new Set());
    workDatesByAgent.get(a.agentId).add(a.date);
  }
  for (const [id, ds] of workDatesByAgent) {
    const ag = agentById.get(id);
    // Οι agents με καλοκαιρινό weekly_pattern εξαιρούνται (Λεωνίδας 7/7 χωρίς ρεπό)
    if (ag && rule(ag, 'weekly_pattern')) continue;
    if (ds.size > 5) {
      warn(`Κ2: ${ag ? ag.name : id} έχει ${ds.size} εργάσιμες (μέγιστο 5)`);
    }
  }

  // ---------- Κ8: 11ωρο — και προς τις γειτονικές εβδομάδες ----------
  const spans = mergeSpans(assignments);
  const prevSpans = mergeSpans(prevAssignments);
  const nextSpans = mergeSpans(nextAssignments);
  const byAgent = new Map();
  for (const s of [...prevSpans.values(), ...spans.values(), ...nextSpans.values()]) {
    if (!byAgent.has(s.agentId)) byAgent.set(s.agentId, []);
    byAgent.get(s.agentId).push(s);
  }
  const weekStartAbs = dayNum(weekStart) * 1440;
  const weekEndAbs = (dayNum(weekEnd) + 1) * 1440;
  for (const [id, list] of byAgent) {
    const ag = agentById.get(id);
    if (!ag) continue;
    const minRest = rule(ag, 'split_shift') ? REST_MIN_SPLIT : REST_MIN;
    list.sort((x, y) => x.startAbs - y.startAbs);
    for (let i = 1; i < list.length; i++) {
      const gap = list[i].startAbs - list[i - 1].endAbs;
      // Ενδιαφέρουν μόνο ζεύγη που αγγίζουν την τρέχουσα εβδομάδα
      const touches = list[i].startAbs < weekEndAbs && list[i - 1].endAbs > weekStartAbs - 7 * 1440;
      if (gap < minRest && gap >= 0 && touches) {
        warn(`Κ8: ${ag.name} — ανάπαυση μόνο ${(gap / 60).toFixed(1)}h (${list[i - 1].date} → ${list[i].date})`, list[i].date);
      }
    }
    // Αν δεν δόθηκαν αναθέσεις προηγούμενης εβδομάδας, χρησιμοποίησε την
    // αποθηκευμένη κατάσταση (λήξη τελευταίας βάρδιας)
    if ((!prevAssignments || prevAssignments.length === 0) && prevState && prevState[id]) {
      const cur = list.filter((s) => s.startAbs >= weekStartAbs).sort((x, y) => x.startAbs - y.startAbs)[0];
      if (cur && prevState[id].lastEndAbs != null && prevState[id].lastEndAbs !== -Infinity) {
        const gap = cur.startAbs - prevState[id].lastEndAbs;
        if (gap < minRest && gap >= 0) {
          warn(`Κ8: ${ag.name} — ανάπαυση μόνο ${(gap / 60).toFixed(1)}h από την τελευταία βάρδια της προηγούμενης εβδομάδας`, cur.date);
        }
      }
    }
  }

  // ---------- Κ10: μέγιστο 5 συνεχόμενες — με σύνορα και προς τις δύο πλευρές ----------
  const allWorkDates = new Map(); // agentId → Set(dayNum)
  // Η άδεια/ασθένεια μετράει ως ΕΡΓΑΣΙΜΗ για το Κ10 (13/07/2026) —
  // μόνο το ρεπό κόβει τη σειρά συνεχόμενων ημερών
  const collect = (arr) => {
    for (const a of arr || []) {
      if (a.off && a.reason !== 'leave' && a.reason !== 'sick') continue;
      if (!allWorkDates.has(a.agentId)) allWorkDates.set(a.agentId, new Set());
      allWorkDates.get(a.agentId).add(dayNum(a.date));
    }
  };
  collect(prevAssignments);
  collect(assignments);
  collect(nextAssignments);
  const wkFirst = dayNum(weekStart);
  const wkLast = dayNum(weekEnd);
  for (const [id, ds] of allWorkDates) {
    const ag = agentById.get(id);
    if (!ag) continue;
    if (rule(ag, 'no_streak_limit')) continue; // εξαίρεση 6ημέρου (Τσιτσικώστες)
    const sorted = [...ds].sort((a, b) => a - b);
    let runStart = sorted[0];
    let prevD = sorted[0];
    // Streak από αποθηκευμένη κατάσταση όταν λείπει η προηγούμενη εβδομάδα
    const st = (!prevAssignments || prevAssignments.length === 0) && prevState && prevState[id];
    for (let i = 1; i <= sorted.length; i++) {
      if (i < sorted.length && sorted[i] === prevD + 1) {
        prevD = sorted[i];
        continue;
      }
      let runLen = prevD - runStart + 1;
      if (st && runStart === wkFirst) runLen += st.streak || 0;
      const touchesWeek = prevD >= wkFirst && runStart <= wkLast;
      if (runLen > MAX_STREAK && touchesWeek) {
        warn(`Κ10: ${ag.name} — ${runLen} συνεχόμενες εργάσιμες μέρες`);
      }
      if (i < sorted.length) {
        runStart = sorted[i];
        prevD = sorted[i];
      }
    }
  }

  // ---------- Κ7 / Κ9 ----------
  for (const a of work) {
    const ag = agentById.get(a.agentId);
    if (!ag) continue;
    if (isNightRow(a) && !ag.canNight) {
      warn(`Κ7: ${ag.name} σε νυχτερινή χωρίς «κάνει βράδυ»`, a.date);
    }
  }

  // ---------- Κανόνες νυχτερινών 14/07/2026 ----------
  // έως 2 βράδια/εβδομάδα, ρεπό μετά το βράδυ (2 σερί βράδια → 2 σερί ρεπό)
  {
    const nightsBy = new Map(); // agentId → sorted dates νυχτερινών
    for (const a of work) {
      if (!isNightRow(a)) continue;
      if (!nightsBy.has(a.agentId)) nightsBy.set(a.agentId, []);
      nightsBy.get(a.agentId).push(a.date);
    }
    const worksOn = (id, date) => work.some((x) => x.agentId === id && x.date === date);
    for (const [id, dates] of nightsBy) {
      const ag = agentById.get(id);
      if (!ag) continue;
      if (dates.length > 2) warn(`Νυχτερινές: ${ag.name} έχει ${dates.length} βράδια την εβδομάδα (μέγιστο 2)`);
      dates.sort();
      // Σειρές συνεχόμενων βραδιών + υποχρεωτική ανάπαυση μετά
      let i = 0;
      while (i < dates.length) {
        let len = 1;
        while (i + len < dates.length && dates[i + len] === addDays(dates[i + len - 1], 1)) len++;
        if (len > 2) warn(`Νυχτερινές: ${ag.name} έχει ${len} ΣΥΝΕΧΟΜΕΝΑ βράδια (μέγιστο 2)`);
        const lastNight = dates[i + len - 1];
        for (let r = 1; r <= Math.min(len, 2); r++) {
          const restDate = addDays(lastNight, r);
          if (worksOn(id, restDate)) {
            warn(`Νυχτερινές: ${ag.name} πρέπει να έχει ${len > 1 ? '2 συνεχόμενα ρεπό' : 'ρεπό'} μετά το βράδυ — δουλεύει ${restDate}`, restDate);
          }
        }
        i += len;
      }
    }
  }
  // Λίστα 06:00-14:00 (απόφαση 11/07/2026): μόνο οι εγκεκριμένοι
  const elig62 = ctx.eligibility.get('06:00-14:00');
  if (elig62 && elig62.size > 0) {
    for (const a of work) {
      if (a.start === '06:00' && a.end === '14:00' && !elig62.has(a.agentId)) {
        const ag = agentById.get(a.agentId);
        warn(`06:00-14:00: ο/η ${ag ? ag.name : a.agentId} ΔΕΝ είναι στη λίστα επιλεξιμότητας της βάρδιας`, a.date);
      }
    }
  }

  const elig1903 = ctx.eligibility.get('19:00-03:00') || new Map();
  const usage1903 = new Map();
  for (const a of work) {
    if (a.start !== '19:00' || a.end !== '03:00') continue;
    const ag = agentById.get(a.agentId);
    const el = elig1903.get(a.agentId);
    if (!el) {
      warn(`Κ9: ${ag ? ag.name : a.agentId} πήρε 19:00-03:00 χωρίς να είναι στη λίστα`, a.date);
      continue;
    }
    usage1903.set(a.agentId, (usage1903.get(a.agentId) || 0) + 1);
    if (usage1903.get(a.agentId) > el.maxPerWeek) {
      warn(`Κ9: ${ag.name} ξεπερνά το όριο ${el.maxPerWeek}/εβδομάδα για τη 19:00-03:00`, a.date);
    }
    // Αγγελή: όχι μόνη στο γραφείο 19:00-03:00
    if (el.notAlone && el.location === 'office') {
      const dayWork = work.filter((x) => x.date === a.date && x.agentId !== a.agentId && x.location !== 'home' && (x.label || '') !== 'ΤΗΛΕΡΓΑΣΙΑ');
      const iv = dayWork.map((x) => {
        const s = toMin(x.start);
        const e = toMin(x.end) <= s ? toMin(x.end) + 1440 : toMin(x.end);
        return [s, e];
      }).filter(([s, e]) => e > 1140 && s < 1620).sort((x, y) => x[0] - y[0]);
      let point = 1140; // 19:00
      let okCover = false;
      for (const [s, e] of iv) {
        if (s > point) break;
        point = Math.max(point, e);
        if (point >= 1620) { okCover = true; break; }
      }
      if (!okCover) {
        warn(`Κ9: ${ag.name} θα μείνει ΜΟΝΗ στο γραφείο σε μέρος της 19:00-03:00`, a.date);
      }
    }
  }

  // ---------- Κ3/Κ5: ατομικοί κανόνες ωραρίου ----------
  for (const a of work) {
    const ag = agentById.get(a.agentId);
    if (!ag) continue;
    const d = dates.indexOf(a.date);
    if (d === -1) continue;
    const is1903 = a.start === '19:00' && a.end === '03:00';
    const telework = a.location === 'home' || (a.label || '').includes('ΤΗΛΕΡΓΑΣΙΑ');
    // Το σπαστό ελέγχεται ως ζεύγος — μεμονωμένα parts εξαιρούνται
    if (rule(ag, 'split_shift')) continue;
    if (!shiftAllowedByRules(ag, d, a.start, a.end, { override1903: is1903, telework, date: a.date })) {
      warn(`Κανόνας agent: ${ag.name} δεν επιτρέπεται να δουλέψει ${a.start}-${a.end} (${['Δευ', 'Τρι', 'Τετ', 'Πεμ', 'Παρ', 'Σαβ', 'Κυρ'][d]})`, a.date);
    }
  }

  // ---------- Κ1: ακάλυπτες απαιτήσεις ----------
  for (let d = 0; d < 7; d++) {
    const date = dates[d];
    const defs = ctx.requirements[d >= 5 ? 'weekend' : 'weekday'];
    const used = new Set(); // δείκτες αναθέσεων που «κατανάλωσε» κάποια απαίτηση
    const dayRows = work.filter((x) => x.date === date);

    for (const def of defs) {
      let covered = 0;
      for (let i = 0; i < dayRows.length && covered < def.headcount; i++) {
        if (used.has(i)) continue;
        const a = dayRows[i];
        const ag = agentById.get(a.agentId);
        if (!ag) continue;
        if (!deptMatch(ag, def.department)) continue;
        if (def.skill && !ag.skills.has(def.skill)) continue;

        let match = a.start === def.start && a.end === def.end;
        // Period-based απαιτήσεις (Πειραιώς/ΗΡΩΝ/Verification πρωί-απόγευμα)
        if (!match && def.period === 'morning' && isMorning(a.start, a.end) && !isNightRow(a)) match = true;
        if (!match && def.period === 'afternoon' && isAfternoon(a.start)) match = true;
        // Νυχτερινή: δεκτή και η εναλλακτική 23:30-07:30 (Κ4)
        if (!match && def.start === '23:00' && isNightRow(a)) match = true;
        if (match) {
          used.add(i);
          covered++;
        }
      }
      // Η 19:00-03:00 καλύπτεται από οποιονδήποτε της λίστας (Κ9 υπερισχύει Κ1)
      if (def.start === '19:00' && covered < def.headcount) {
        for (let i = 0; i < dayRows.length && covered < def.headcount; i++) {
          if (used.has(i)) continue;
          const a = dayRows[i];
          if (a.start === '19:00' && a.end === '03:00' && elig1903.has(a.agentId)) {
            used.add(i);
            covered++;
          }
        }
      }
      if (covered < def.headcount) {
        uncovered.push({ date, start: def.start, end: def.end, label: def.label, missing: def.headcount - covered });
      }
    }
  }

  return { warnings, uncovered };
}

// Υπολογισμός κατάστασης τέλους εβδομάδας από αποθηκευμένες αναθέσεις —
// χρησιμοποιείται στην αποθήκευση (οι χειροκίνητες αλλαγές αλλάζουν streaks
// κ.λπ., οπότε η κατάσταση ΞΑΝΑϋπολογίζεται, δεν κρατιέται του generator).
async function computeStateFromAssignments(weekStart, assignments, prevState) {
  const weekEnd = addDays(weekStart, 6);
  const ctx = await loadContext(weekStart, weekEnd);
  const state = {};
  const base = prevState || {};

  for (const ag of ctx.agents) {
    const prev = base[ag.id] || { streak: 0, lastEndAbs: -Infinity, nights: 0, weekends: 0, count1903: 0, rizouMode: 'morning' };
    const rows = (assignments || []).filter((a) => !a.off && a.agentId === ag.id);
    // Streak: η άδεια/ασθένεια μετράει ως εργάσιμη (13/07/2026)
    const leaveDays = (assignments || [])
      .filter((a) => a.off && a.agentId === ag.id && (a.reason === 'leave' || a.reason === 'sick'))
      .map((a) => dayNum(a.date));
    const workedDays = new Set([...rows.map((r) => dayNum(r.date)), ...leaveDays]);

    // Streak που καταλήγει στην Κυριακή
    let streak = 0;
    let dnum = dayNum(weekEnd);
    while (workedDays.has(dnum)) {
      streak++;
      dnum--;
    }
    if (streak === 7) streak += prev.streak;

    let lastEndAbs = prev.lastEndAbs;
    let nights = prev.nights;
    let wknd = 0;
    const wkndDates = new Set([addDays(weekStart, 5), addDays(weekStart, 6)]);
    const wkndSeen = new Set();
    for (const r of rows) {
      const abs = shiftAbs(r.date, r.start, r.end);
      lastEndAbs = Math.max(lastEndAbs, abs.endAbs);
      if (isNightRow(r)) nights++;
      if (wkndDates.has(r.date) && !wkndSeen.has(r.date)) {
        wknd++;
        wkndSeen.add(r.date);
      }
    }

    let count1903 = prev.count1903;
    for (const r of rows) if (r.start === '19:00' && r.end === '03:00') count1903++;
    let count62 = prev.count62 || 0;
    for (const r of rows) if (r.start === '06:00' && r.end === '14:00') count62++;

    // Μετρητές Κυριακών ανά μήνα: δουλεμένες (όριο 2/μήνα) και ρεπό
    // (sunday_worker: το πολύ 1 ρεπό Κυριακής/μήνα — 12/07/2026)
    const sundays = { ...(prev.sundays || {}) };
    const sundaysOff = { ...(prev.sundaysOff || {}) };
    const sundayDate = addDays(weekStart, 6);
    const mk = sundayDate.slice(0, 7);
    if (rows.some((r) => r.date === sundayDate)) {
      sundays[mk] = (sundays[mk] || 0) + 1;
    } else {
      const offRow = (assignments || []).find((x) => x.off && x.agentId === ag.id && x.date === sundayDate);
      const isLeave = offRow && (offRow.reason === 'leave' || offRow.reason === 'sick');
      if (!isLeave) sundaysOff[mk] = (sundaysOff[mk] || 0) + 1;
    }
    for (const k of Object.keys(sundays).sort().slice(0, -3)) delete sundays[k];
    for (const k of Object.keys(sundaysOff).sort().slice(0, -3)) delete sundaysOff[k];

    // Οφειλόμενη ανάπαυση από βράδια στο τέλος της εβδομάδας (14/07/2026):
    // σειρά βραδιών που τελειώνει προς την Κυριακή → τόσα ρεπό στην επόμενη
    let pendingNightRest = 0;
    {
      const nightDates = rows.filter((r) => isNightRow(r)).map((r) => r.date).sort();
      if (nightDates.length) {
        let len = 1;
        for (let i = nightDates.length - 1; i > 0 && nightDates[i - 1] === addDays(nightDates[i], -1); i--) len++;
        const lastNight = nightDates[nightDates.length - 1];
        const restBeyond = dayNum(lastNight) + len - dayNum(weekEnd); // πόσα ρεπό πέφτουν μετά την Κυριακή
        pendingNightRest = Math.max(0, Math.min(len, restBeyond));
      }
    }

    let rizouMode = prev.rizouMode;
    if (rule(ag, 'weekly_alternation') && rows.length > 0) {
      // Η επόμενη εβδομάδα παίρνει το αντίθετο απ' ό,τι δούλεψε κυρίως τώρα
      const mornings = rows.filter((r) => toMin(r.start) < 720).length;
      rizouMode = mornings >= rows.length / 2 ? 'afternoon' : 'morning';
    }

    state[ag.id] = { streak, lastEndAbs, nights, weekends: prev.weekends + wknd, count1903, count62, sundays, sundaysOff, pendingNightRest, rizouMode };
  }
  return state;
}

module.exports = { validateWeek, computeStateFromAssignments };
