// Test script generator (ΒΗΜΑ 4): παράγει ΟΛΟΚΛΗΡΟ μήνα στην κονσόλα και
// ελέγχει αυτόματα:
//   1. Κανένα 6ήμερο (Κ10) — και στα σύνορα εβδομάδων
//   2. Κανένα σπάσιμο 11ώρου (Κ8) — και στα σύνορα εβδομάδων
//      (εξαίρεση: σπαστό Κουλογιάννη 24:00→09:00 = 9h, δηλωμένο σταθερό Κ5)
//   3. 2 ρεπό/εβδομάδα και μέγιστο 5 εργάσιμες για ΟΛΟΥΣ (Κ2)
//   4. Όλα τα σταθερά ωράρια στη θέση τους (Κ5)
//   5. Νυχτερινές μόνο από επιτρεπόμενους (Κ7) + 19:00-03:00 μόνο από λίστα με όρια (Κ9)
//   6. Κανόνες Νικολιάδη/Νικολιάδη Αλίκης (Κ3): μόνο πρωί, μέρες σχολής
// Τυπώνει PASS/FAIL ανά έλεγχο.
//
// Χρήση: node scripts/test_generator.js [YYYY-MM]   (default: 2026-07)
const { generatePeriod } = require('../src/scheduler');
const { weeksCovering, monthBounds, dayOfWeek } = require('../src/utils/dates');
const { shiftAbs, toMin, isMorning } = require('../src/scheduler/time');
const pool = require('../src/db/pool');

const month = process.argv[2] || '2026-07';
const DAY_GR = ['Δευ', 'Τρι', 'Τετ', 'Πεμ', 'Παρ', 'Σαβ', 'Κυρ'];

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (cond || !detail ? '' : '\n       ' + detail));
  if (!cond) failures++;
}

(async () => {
  const { from, to } = monthBounds(month);
  const weeks = weeksCovering(from, to);
  console.log(`\n=== Παραγωγή προγράμματος: ${month} → ${weeks.length} εβδομάδες (${weeks[0].start} … ${weeks[weeks.length - 1].end}) ===\n`);

  const t0 = Date.now();
  const result = await generatePeriod(weeks);
  console.log(`(χρόνος παραγωγής: ${Date.now() - t0}ms)\n`);

  // Φόρτωση agents για ονόματα/έλεγχο
  const [agents] = await pool.query('SELECT id, full_name FROM agents WHERE active = 1');
  const nameOf = Object.fromEntries(agents.map((a) => [a.id, a.full_name]));
  const idOf = Object.fromEntries(agents.map((a) => [a.full_name, a.id]));
  const [eligRows] = await pool.query('SELECT agent_id, max_per_week FROM shift_eligibility');
  const eligMax = Object.fromEntries(eligRows.map((e) => [e.agent_id, e.max_per_week]));

  // ---------- Εκτύπωση προγράμματος ----------
  for (const wk of result.weeks) {
    console.log(`\n──────── Εβδομάδα ${wk.weekStart} ────────`);
    const byAgent = new Map();
    for (const a of wk.assignments) {
      if (!byAgent.has(a.agentId)) byAgent.set(a.agentId, new Array(7).fill(''));
      const d = wk.dates.indexOf(a.date);
      const cell = a.off
        ? (a.reason === 'leave' ? 'ΑΔΕΙΑ' : a.reason === 'sick' ? 'ΑΣΘΕΝ' : 'ΡΕΠΟ')
        : `${a.start}-${a.end}${a.label ? '*' : ''}`;
      byAgent.get(a.agentId)[d] = byAgent.get(a.agentId)[d] ? byAgent.get(a.agentId)[d] + '+' + cell : cell;
    }
    const names = [...byAgent.keys()].sort((x, y) => (nameOf[x] || '').localeCompare(nameOf[y] || '', 'el'));
    for (const id of names) {
      const row = byAgent.get(id).map((c) => (c || '—').padEnd(13)).join('');
      console.log((nameOf[id] || id).padEnd(30) + row);
    }
    if (wk.report.uncovered.length) {
      console.log('  ΑΚΑΛΥΠΤΑ: ' + wk.report.uncovered.map((u) => `${u.date} ${u.start}-${u.end} ${u.label}`).join(' | '));
    }
    if (wk.report.soft.length) {
      console.log('  SOFT: ' + wk.report.soft.join(' | '));
    }
  }

  // ---------- Συγκέντρωση όλων των αναθέσεων της περιόδου ----------
  const workRows = [];
  const offRows = [];
  for (const wk of result.weeks) {
    for (const a of wk.assignments) {
      if (a.off) offRows.push(a);
      else workRows.push(a);
    }
  }

  console.log('\n=== ΑΥΤΟΜΑΤΟΙ ΕΛΕΓΧΟΙ ===\n');

  // ---------- 1. Κ10: κανένα 6ήμερο (σε ΟΛΗ την περίοδο, με σύνορα) ----------
  {
    const daysWorked = new Map(); // agentId → Set(dates)
    for (const a of workRows) {
      if (!daysWorked.has(a.agentId)) daysWorked.set(a.agentId, new Set());
      daysWorked.get(a.agentId).add(a.date);
    }
    let bad = null;
    for (const [id, dates] of daysWorked) {
      const sorted = [...dates].sort();
      let run = 1;
      for (let i = 1; i < sorted.length; i++) {
        const prev = new Date(sorted[i - 1] + 'T12:00:00');
        const cur = new Date(sorted[i] + 'T12:00:00');
        if ((cur - prev) / 86400000 === 1) {
          run++;
          if (run > 5) { bad = `${nameOf[id]}: 6+ συνεχόμενες μέρες έως ${sorted[i]}`; break; }
        } else {
          run = 1;
        }
      }
      if (bad) break;
    }
    check('Κ10: κανένα 6ήμερο σε όλη την περίοδο (και στα σύνορα εβδομάδων)', !bad, bad);
  }

  // ---------- 2. Κ8: 11ωρο παντού (σύνορα εβδομάδων συμπεριλαμβάνονται) ----------
  {
    const koulId = idOf['ΚΟΥΛΟΓΙΑΝΝΗΣ ΚΥΡΙΑΚΟΣ'];
    // Ενοποίηση σπαστών (ίδιος agent, ίδια μέρα) σε ένα διάστημα
    const merged = new Map(); // agentId|date → {startAbs, endAbs}
    for (const a of workRows) {
      const abs = shiftAbs(a.date, a.start, a.end);
      const key = `${a.agentId}|${a.date}`;
      const cur = merged.get(key);
      if (cur) {
        cur.startAbs = Math.min(cur.startAbs, abs.startAbs);
        cur.endAbs = Math.max(cur.endAbs, abs.endAbs);
      } else {
        merged.set(key, { agentId: a.agentId, ...abs });
      }
    }
    const byAgent = new Map();
    for (const m of merged.values()) {
      if (!byAgent.has(m.agentId)) byAgent.set(m.agentId, []);
      byAgent.get(m.agentId).push(m);
    }
    let bad = null;
    let koulNote = false;
    for (const [id, list] of byAgent) {
      list.sort((x, y) => x.startAbs - y.startAbs);
      const minRest = id === koulId ? 9 * 60 : 11 * 60;
      for (let i = 1; i < list.length; i++) {
        const gap = list[i].startAbs - list[i - 1].endAbs;
        if (gap < minRest) {
          bad = `${nameOf[id]}: ανάπαυση ${(gap / 60).toFixed(1)}h`;
          break;
        }
        if (id === koulId && gap < 11 * 60) koulNote = true;
      }
      if (bad) break;
    }
    check('Κ8: ανάπαυση ≥ 11h παντού (εξαίρεση: σπαστό Κουλογιάννη ≥ 9h βάσει Κ5)', !bad, bad);
    if (koulNote) console.log('       (σημ.: το σπαστό του Κουλογιάννη δίνει 9h 24:00→09:00 — δηλωμένο σταθερό ωράριο)');
  }

  // ---------- 3. Κ2: ≤5 εργάσιμες & ≥2 ρεπό ανά εβδομάδα για όλους ----------
  {
    let bad = null;
    for (const wk of result.weeks) {
      const workDays = new Map();
      const offDays = new Map();
      const leaveDays = new Map();
      for (const a of wk.assignments) {
        const map = a.off ? (a.reason === 'leave' || a.reason === 'sick' ? leaveDays : offDays) : workDays;
        if (!map.has(a.agentId)) map.set(a.agentId, new Set());
        map.get(a.agentId).add(a.date);
      }
      for (const ag of agents) {
        const wcount = (workDays.get(ag.id) || new Set()).size;
        const ocount = (offDays.get(ag.id) || new Set()).size;
        const lcount = (leaveDays.get(ag.id) || new Set()).size;
        if (wcount > 5) { bad = `${ag.full_name} εβδ. ${wk.weekStart}: ${wcount} εργάσιμες`; break; }
        if (ocount + lcount < 2 && wcount + ocount + lcount === 7) { bad = `${ag.full_name} εβδ. ${wk.weekStart}: μόνο ${ocount} ρεπό`; break; }
        if (wcount + ocount + lcount !== 7) { bad = `${ag.full_name} εβδ. ${wk.weekStart}: ${wcount}+${ocount}+${lcount} ≠ 7 μέρες`; break; }
      }
      if (bad) break;
    }
    check('Κ2: μέγιστο 5 εργάσιμες, τουλάχιστον 2 ρεπό, 7 μέρες λογαριασμένες για όλους', !bad, bad);
  }

  // ---------- 4. Κ5: σταθερά ωράρια στη θέση τους ----------
  {
    const fixedChecks = [
      { name: 'ΚΟΚΙΟΠΟΥΛΟΥ ΔΑΝΑΗ', days: [1, 2, 3, 4, 5], start: '16:00', end: '24:00' },
      { name: 'ΔΗΜΗΤΡΙΟΥ ΕΛΕΝΗ', days: [1, 2, 3, 4, 5], start: '08:00', end: '16:00' },
      { name: 'ΜΠΟΥΚΗ ΧΡΙΣΤΙΝΑ', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
      { name: 'ΠΟΥΛΑΚΟΣ ΓΙΑΝΝΗΣ', days: [1, 2, 3, 4, 5], start: '10:00', end: '18:00' },
      { name: 'ΠΡΙΜΑΛΗ ΕΛΕΝΗ', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
      { name: 'ΠΙΠΕΡΙΔΗ ΕΥΑΓΓΕΛΙΑ', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }
    ];
    let bad = null;
    const workIdx = new Map(); // agentId|date → [rows]
    for (const a of workRows) {
      const k = `${a.agentId}|${a.date}`;
      if (!workIdx.has(k)) workIdx.set(k, []);
      workIdx.get(k).push(a);
    }
    const offIdx = new Set(offRows.map((o) => `${o.agentId}|${o.date}`));

    outer:
    for (const fc of fixedChecks) {
      const id = idOf[fc.name];
      for (const wk of result.weeks) {
        for (const date of wk.dates) {
          if (!fc.days.includes(dayOfWeek(date))) continue;
          const rows = workIdx.get(`${id}|${date}`) || [];
          const okRow = rows.some((r) => r.start === fc.start && r.end === fc.end);
          const isOff = offIdx.has(`${id}|${date}`);
          if (!okRow && !isOff) { bad = `${fc.name} ${date}: δεν βρέθηκε ${fc.start}-${fc.end}`; break outer; }
        }
      }
    }
    check('Κ5: σταθερά ωράρια (Κοκιοπούλου, Δημητρίου, Μπούκη, Πουλάκος, Πριμάλη, Πιπερίδη)', !bad, bad);

    // Αγγελούδη: ρεπό Δευ+Τρι, ΣΚ 16:00-24:00
    const aggId = idOf['ΑΓΓΕΛΟΥΔΗ ΜΑΡΙΑ'];
    let aggBad = null;
    for (const wk of result.weeks) {
      for (const date of wk.dates) {
        const dow = dayOfWeek(date);
        if (dow <= 2 && !offIdx.has(`${aggId}|${date}`)) aggBad = `${date}: δεν έχει ρεπό (Δευ/Τρι)`;
        if (dow >= 6) {
          const rows = workIdx.get(`${aggId}|${date}`) || [];
          if (!rows.some((r) => r.start === '16:00' && r.end === '24:00')) aggBad = `${date}: λείπει ΣΚ 16:00-24:00`;
        }
      }
    }
    check('Κ5/constraints: Αγγελούδη — ρεπό Δευ+Τρι, ΣΚ 16:00-24:00', !aggBad, aggBad);

    // Τσιτσικώστας Αλ.: ρεπό Τετ+Πεμ
    const tsId = idOf['ΤΣΙΤΣΙΚΩΣΤΑΣ ΑΛΕΞΑΝΔΡΟΣ'];
    let tsBad = null;
    for (const wk of result.weeks) {
      for (const date of wk.dates) {
        const dow = dayOfWeek(date);
        if ((dow === 3 || dow === 4) && !offIdx.has(`${tsId}|${date}`)) tsBad = `${date}: δεν έχει ρεπό (Τετ/Πεμ)`;
      }
    }
    check('Constraints: Τσιτσικώστας Αλ. — σταθερά ρεπό Τετ+Πεμ', !tsBad, tsBad);

    // Κουλογιάννης: σπαστό 09-14 + 21-24 καθημερινές, ΣΚ ρεπό
    const koulId = idOf['ΚΟΥΛΟΓΙΑΝΝΗΣ ΚΥΡΙΑΚΟΣ'];
    let koulBad = null;
    for (const wk of result.weeks) {
      for (const date of wk.dates) {
        const dow = dayOfWeek(date);
        const rows = workIdx.get(`${koulId}|${date}`) || [];
        if (dow <= 5) {
          const hasParts = rows.some((r) => r.start === '09:00' && r.end === '14:00') &&
            rows.some((r) => r.start === '21:00' && r.end === '24:00');
          if (!hasParts && !offIdx.has(`${koulId}|${date}`)) koulBad = `${date}: λείπει το σπαστό`;
        } else if (rows.length) {
          koulBad = `${date}: δουλεύει ΣΚ`;
        }
      }
    }
    check('Constraints: Κουλογιάννης — σπαστό 09:00-14:00 + 21:00-24:00 καθημερινές, ΣΚ ρεπό', !koulBad, koulBad);
  }

  // ---------- 5. Κ7/Κ9: νυχτερινές & 19:00-03:00 ----------
  {
    const nightOk = new Set([idOf['ΝΟΜΙΚΟΥ ΝΟΤΑ'], idOf['ΜΑΥΡΑΓΑΝΗ ΝΙΚΟΛΕΤΑ']]);
    let bad = null;
    for (const a of workRows) {
      if ((a.start === '23:00' || a.start === '23:30') && toMin(a.end) < toMin(a.start)) {
        if (!nightOk.has(a.agentId)) { bad = `${nameOf[a.agentId]} πήρε νυχτερινή ${a.date}`; break; }
      }
    }
    check('Κ7: νυχτερινές ΜΟΝΟ σε Νομικού/Μαυραγάνη (απόφαση 09/07/2026)', !bad, bad);

    let bad19 = null;
    const usage = new Map(); // week|agent → count
    for (const wk of result.weeks) {
      for (const a of wk.assignments) {
        if (!a.off && a.start === '19:00' && a.end === '03:00') {
          if (eligMax[a.agentId] === undefined) { bad19 = `${nameOf[a.agentId]} εκτός λίστας πήρε 19:00-03:00 (${a.date})`; break; }
          const k = `${wk.weekStart}|${a.agentId}`;
          usage.set(k, (usage.get(k) || 0) + 1);
          if (usage.get(k) > eligMax[a.agentId]) { bad19 = `${nameOf[a.agentId]} ξεπέρασε το όριο (${usage.get(k)}>${eligMax[a.agentId]}) εβδ. ${wk.weekStart}`; break; }
        }
      }
      if (bad19) break;
    }
    check('Κ9: 19:00-03:00 μόνο από τη λίστα, εντός ορίων/εβδομάδα', !bad19, bad19);
  }

  // ---------- 6. Κ3: Νικολιάδης & Νικολιάδη Αλίκη ----------
  {
    const nikId = idOf['ΝΙΚΟΛΙΑΔΗΣ ΝΙΚΟΣ'];
    const alikiId = idOf['ΝΙΚΟΛΙΑΔΗ ΑΛΙΚΗ'];
    let bad = null;
    for (const a of workRows) {
      if (a.agentId !== nikId && a.agentId !== alikiId) continue;
      const who = nameOf[a.agentId];
      const dow = dayOfWeek(a.date);
      if (!isMorning(a.start, a.end)) { bad = `${who} ${a.date}: όχι πρωινή (${a.start}-${a.end})`; break; }
      const ruleDays = a.agentId === nikId ? [1, 5] : [2, 5];
      if (ruleDays.includes(dow) && !(a.start === '06:00' && a.end === '14:00')) {
        bad = `${who} ${a.date} (μέρα σχολής): ${a.start}-${a.end} αντί για ρεπό/τηλεργασία 06:00-14:00`;
        break;
      }
      if (a.agentId === alikiId && !ruleDays.includes(dow) && !['07:30', '08:00'].includes(a.start)) {
        bad = `Αλίκη ${a.date}: έναρξη ${a.start} (επιτρεπτές 07:30/08:00)`;
        break;
      }
    }
    check('Κ3: Νικολιάδης/Νικολιάδη Αλίκη — μόνο πρωί, μέρες σχολής ρεπό ή τηλεργασία 06:00-14:00', !bad, bad);
  }

  // ---------- Σύνοψη κάλυψης ----------
  {
    let totalUncovered = 0;
    for (const wk of result.weeks) totalUncovered += wk.report.uncovered.length;
    console.log(`\nΑκάλυπτες απαιτήσεις συνολικά: ${totalUncovered}`);
    const byLabel = new Map();
    for (const wk of result.weeks) {
      for (const u of wk.report.uncovered) {
        const k = `${u.start}-${u.end} ${u.label}`;
        byLabel.set(k, (byLabel.get(k) || 0) + 1);
      }
    }
    for (const [k, n] of byLabel) console.log(`  ${k}: ${n} φορές`);
  }

  console.log(`\n${failures === 0 ? '✔ ΟΛΟΙ ΟΙ ΕΛΕΓΧΟΙ ΠΕΡΑΣΑΝ' : '✘ ' + failures + ' ΕΛΕΓΧΟΙ ΑΠΕΤΥΧΑΝ'}\n`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('Σφάλμα:', e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
