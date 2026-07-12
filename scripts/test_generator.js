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
  // Εξαίρεση (11/07/2026): οι δύο Τσιτσικώστες δεν έχουν όριο 6ημέρου
  {
    const k10Exempt = new Set([idOf['ΤΣΙΤΣΙΚΩΣΤΑΣ ΑΛΕΞΑΝΔΡΟΣ'], idOf['ΤΣΙΤΣΙΚΩΣΤΑΣ ΛΕΩΝΙΔΑΣ']]);
    const daysWorked = new Map(); // agentId → Set(dates)
    for (const a of workRows) {
      if (k10Exempt.has(a.agentId)) continue;
      if (!daysWorked.has(a.agentId)) daysWorked.set(a.agentId, new Set());
      daysWorked.get(a.agentId).add(a.date);
    }
    // Η άδεια/ασθένεια μετράει ως ΕΡΓΑΣΙΜΗ για το Κ10 (13/07/2026)
    for (const a of offRows) {
      if (a.reason !== 'leave' && a.reason !== 'sick') continue;
      if (k10Exempt.has(a.agentId)) continue;
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
      // Εξαίρεση Κ2: οι Τσιτσικώστες με καλοκαιρινό weekly_pattern (11/07/2026 —
      // ο Λεωνίδας δουλεύει 7/7 χωρίς ρεπό)
      const k2Exempt = new Set([idOf['ΤΣΙΤΣΙΚΩΣΤΑΣ ΑΛΕΞΑΝΔΡΟΣ'], idOf['ΤΣΙΤΣΙΚΩΣΤΑΣ ΛΕΩΝΙΔΑΣ']]);
      for (const ag of agents) {
        const wcount = (workDays.get(ag.id) || new Set()).size;
        const ocount = (offDays.get(ag.id) || new Set()).size;
        const lcount = (leaveDays.get(ag.id) || new Set()).size;
        if (!k2Exempt.has(ag.id)) {
          if (wcount > 5) { bad = `${ag.full_name} εβδ. ${wk.weekStart}: ${wcount} εργάσιμες`; break; }
          if (ocount + lcount < 2 && wcount + ocount + lcount === 7) { bad = `${ag.full_name} εβδ. ${wk.weekStart}: μόνο ${ocount} ρεπό`; break; }
        }
        if (wcount + ocount + lcount !== 7) { bad = `${ag.full_name} εβδ. ${wk.weekStart}: ${wcount}+${ocount}+${lcount} ≠ 7 μέρες`; break; }
      }
      if (bad) break;
    }
    check('Κ2: μέγιστο 5 εργάσιμες, τουλάχιστον 2 ρεπό (εκτός Τσιτσικωστών), 7 μέρες λογαριασμένες', !bad, bad);
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

    // Αγγελούδη: ρεπό Δευ+Τρι, ΣΚ 16:00-24:00 — μέρες με άδεια/αίτημα ή
    // ρεπό-προστασίας Κ10 δικαιολογούνται
    const aggId = idOf['ΑΓΓΕΛΟΥΔΗ ΜΑΡΙΑ'];
    let aggBad = null;
    for (const wk of result.weeks) {
      for (const date of wk.dates) {
        const dow = dayOfWeek(date);
        if (dow <= 2 && !offIdx.has(`${aggId}|${date}`)) aggBad = `${date}: δεν έχει ρεπό (Δευ/Τρι)`;
        if (dow >= 6) {
          const rows = workIdx.get(`${aggId}|${date}`) || [];
          const ok = rows.some((r) => r.start === '16:00' && r.end === '24:00') || offIdx.has(`${aggId}|${date}`);
          if (!ok) aggBad = `${date}: λείπει ΣΚ 16:00-24:00`;
        }
      }
    }
    check('Κ5/constraints: Αγγελούδη — ρεπό Δευ+Τρι, ΣΚ 16:00-24:00 (με δικαιολογημένες απουσίες)', !aggBad, aggBad);

    // Καλοκαιρινά weekly_pattern Τσιτσικωστών (από 15/06 — 11/07/2026)
    const PATTERNS = {
      'ΤΣΙΤΣΙΚΩΣΤΑΣ ΑΛΕΞΑΝΔΡΟΣ': { 1: '18:00-24:00', 2: '13:00-21:00', 3: '18:00-24:00', 4: '13:00-21:00', 7: '16:00-24:00' },
      'ΤΣΙΤΣΙΚΩΣΤΑΣ ΛΕΩΝΙΔΑΣ': { 1: '20:00-24:00', 2: '20:00-24:00', 3: '18:00-22:00', 4: '15:00-23:00', 5: '18:00-22:00', 6: '15:00-23:00', 7: '16:00-24:00' }
    };
    // Μέρες με ΑΔΕΙΑ/ασθένεια/αίτημα ρεπό (δεδομένα χρήστη) δικαιολογούνται
    const excusedOff = new Set(
      offRows.filter((o) => ['leave', 'sick', 'repo_request'].includes(o.reason)).map((o) => `${o.agentId}|${o.date}`)
    );
    for (const [name, pattern] of Object.entries(PATTERNS)) {
      const id = idOf[name];
      let pBad = null;
      for (const wk of result.weeks) {
        for (const date of wk.dates) {
          const dow = dayOfWeek(date);
          const want = pattern[dow];
          const rows = workIdx.get(`${id}|${date}`) || [];
          if (want) {
            const ok = rows.some((r) => `${r.start}-${r.end}` === want) || excusedOff.has(`${id}|${date}`);
            if (!ok) { pBad = `${date}: αναμενόταν ${want}, βρέθηκε ${rows.map((r) => r.start + '-' + r.end).join(',') || 'ρεπό'}`; break; }
          } else if (rows.length) {
            pBad = `${date}: δουλεύει ενώ το μοτίβο δίνει ρεπό`;
            break;
          }
        }
        if (pBad) break;
      }
      check(`Καλοκαιρινό πρόγραμμα ${name}${name.includes('ΛΕΩΝ') ? ' (7/7 χωρίς ρεπό)' : ' (Παρ+Σαβ ρεπό)'}`, !pBad, pBad);
    }

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
    // Δυναμικά από τη βάση: νυχτερινή επιτρέπεται ΜΟΝΟ με can_night=1 + skill
    // EUROBANK (ό,τι ισχύει τη στιγμή του τεστ — επεξεργάσιμο από οθόνη Agents)
    const [nightRows] = await pool.query(
      `SELECT DISTINCT a.id FROM agents a
       JOIN agent_skills ask ON ask.agent_id = a.id
       JOIN skills s ON s.id = ask.skill_id
       WHERE a.active = 1 AND a.can_night = 1 AND s.name = 'EUROBANK'`
    );
    const nightOk = new Set(nightRows.map((r) => r.id));
    let bad = null;
    for (const a of workRows) {
      if ((a.start === '23:00' || a.start === '23:30') && toMin(a.end) < toMin(a.start)) {
        if (!nightOk.has(a.agentId)) { bad = `${nameOf[a.agentId]} πήρε νυχτερινή ${a.date}`; break; }
      }
    }
    check(`Κ7: νυχτερινές ΜΟΝΟ από agents με can_night + EUROBANK (${nightRows.length} επιλέξιμοι)`, !bad, bad);

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
      // ΣΚ: το 06:00-14:00 επιτρέπεται («μόνο αν βγαίνει» — 11/07/2026)
      if (a.agentId === alikiId && !ruleDays.includes(dow) && !['07:30', '08:00'].includes(a.start) &&
          !(dow >= 6 && a.start === '06:00' && a.end === '14:00')) {
        bad = `Αλίκη ${a.date}: έναρξη ${a.start} (επιτρεπτές 07:30/08:00)`;
        break;
      }
    }
    check('Κ3: Νικολιάδης/Νικολιάδη Αλίκη — μόνο πρωί, μέρες σχολής ρεπό ή τηλεργασία 06:00-14:00', !bad, bad);
  }

  // ---------- 7. Όριο Κυριακών/μήνα (11/07/2026) ----------
  {
    const [exemptRows] = await pool.query(
      `SELECT id, full_name FROM agents WHERE active = 1 AND
       (departments LIKE '%supervisor%' OR weekend_shift IS NOT NULL OR (fixed_shift_start IS NOT NULL AND fixed_days IS NOT NULL))`
    );
    const exempt = new Set(exemptRows.map((r) => r.id));
    // Σταθερό καλοκαιρινό μοτίβο = σταθεροί → εκτός ορίου Κυριακών
    exempt.add(idOf['ΤΣΙΤΣΙΚΩΣΤΑΣ ΑΛΕΞΑΝΔΡΟΣ']);
    exempt.add(idOf['ΤΣΙΤΣΙΚΩΣΤΑΣ ΛΕΩΝΙΔΑΣ']);
    const nikId = idOf['ΝΙΚΟΛΙΑΔΗΣ ΝΙΚΟΣ'];
    const perMonth = new Map(); // agentId|YYYY-MM → count
    for (const a of workRows) {
      const dow = dayOfWeek(a.date);
      if (dow !== 7) continue;
      const k = `${a.agentId}|${a.date.slice(0, 7)}`;
      if (!perMonth.has(k)) perMonth.set(k, new Set());
      perMonth.get(k).add(a.date);
    }
    let bad = null;
    for (const [k, ds] of perMonth) {
      const [idStr, mk] = k.split('|');
      const id = Number(idStr);
      if (exempt.has(id) || id === nikId) continue; // Νικολιάδης: χωρίς όριο δουλεμένων Κυριακών
      if (ds.size > 2) { bad = `${nameOf[id]}: ${ds.size} Κυριακές τον ${mk} (όριο 2)`; break; }
    }
    check('Όριο Κυριακών: ≤2/μήνα (μη σταθεροί, εκτός supervisors)', !bad, bad);

    // Νικολιάδης: δουλεύει Κυριακές — το πολύ 1 ΡΕΠΟ Κυριακής/μήνα (12/07/2026)
    const nikSundaysOff = new Map(); // month → count
    for (const wk of result.weeks) {
      const sunday = wk.dates[6];
      const workedSunday = wk.assignments.some((a) => !a.off && a.agentId === nikId && a.date === sunday);
      // Άδεια/ασθένεια ΚΑΙ δικά του αιτήματα ρεπό δεν μετράνε στο όριο —
      // μόνο τα ρεπό που διάλεξε ο generator (13/07/2026)
      const excused = wk.assignments.some((a) => a.off && a.agentId === nikId && a.date === sunday &&
        ['leave', 'sick', 'repo_request'].includes(a.reason));
      if (!workedSunday && !excused) {
        const mk = sunday.slice(0, 7);
        nikSundaysOff.set(mk, (nikSundaysOff.get(mk) || 0) + 1);
      }
    }
    const nikBad = [...nikSundaysOff.entries()].find(([, n]) => n > 1);
    check('Νικολιάδης: το πολύ 1 ρεπό Κυριακής τον μήνα — τις υπόλοιπες δουλεύει',
      !nikBad, nikBad ? `${nikBad[1]} ρεπό Κυριακής τον ${nikBad[0]}` : null);
  }

  // ---------- 8. Λίστα 06:00-14:00 (11/07/2026) ----------
  {
    const [eligRows62] = await pool.query(
      "SELECT agent_id FROM shift_eligibility WHERE shift_start = '06:00' AND shift_end = '14:00'"
    );
    const allowed62 = new Set(eligRows62.map((r) => r.agent_id));
    let bad = null;
    for (const a of workRows) {
      if (a.start === '06:00' && a.end === '14:00' && !allowed62.has(a.agentId)) {
        bad = `${nameOf[a.agentId]} πήρε 06:00-14:00 (${a.date}) εκτός λίστας`;
        break;
      }
    }
    check(`Το 06:00-14:00 ΜΟΝΟ από τη λίστα των ${allowed62.size} εγκεκριμένων`, !bad, bad);

    // Νικολιάδης/Νικολιάδη: 6-2 μόνο στις μέρες τους (ΣΚ επιτρεπτό)
    const nikDays = { [idOf['ΝΙΚΟΛΙΑΔΗΣ ΝΙΚΟΣ']]: [1, 5], [idOf['ΝΙΚΟΛΙΑΔΗ ΑΛΙΚΗ']]: [2, 5] };
    let bad2 = null;
    for (const a of workRows) {
      const days = nikDays[a.agentId];
      if (!days || a.start !== '06:00' || a.end !== '14:00') continue;
      const dow = dayOfWeek(a.date);
      if (!days.includes(dow) && dow < 6) { bad2 = `${nameOf[a.agentId]} 06:00-14:00 ${a.date} (μέρα ${dow})`; break; }
    }
    check('Νικολιάδης 6-2 μόνο Δευ/Παρ, Νικολιάδη μόνο Τρι/Παρ (ΣΚ επιτρεπτό)', !bad2, bad2);
  }

  // ---------- 9. Κανόνες νυχτερινών (14/07/2026) ----------
  {
    const { addDays } = require('../src/utils/dates');
    // ≤2 βράδια/εβδομάδα
    let bad = null;
    for (const wk of result.weeks) {
      const per = new Map();
      for (const a of wk.assignments) {
        if (a.off || !((a.start === '23:00' || a.start === '23:30') && toMin(a.end) < toMin(a.start))) continue;
        per.set(a.agentId, (per.get(a.agentId) || 0) + 1);
      }
      for (const [id, n] of per) if (n > 2) { bad = `${nameOf[id]}: ${n} βράδια εβδ. ${wk.weekStart}`; break; }
      if (bad) break;
    }
    check('Βράδια: το πολύ 2/εβδομάδα ανά agent', !bad, bad);

    // Τα 2 βράδια της εβδομάδας ΣΥΝΕΧΟΜΕΝΑ (14/07/2026)
    let badPair = null;
    for (const wk of result.weeks) {
      const per = new Map();
      for (const a of wk.assignments) {
        if (a.off || !((a.start === '23:00' || a.start === '23:30') && toMin(a.end) < toMin(a.start))) continue;
        if (!per.has(a.agentId)) per.set(a.agentId, []);
        per.get(a.agentId).push(a.date);
      }
      for (const [id, ds] of per) {
        if (ds.length === 2) {
          ds.sort();
          if (ds[1] !== addDays(ds[0], 1)) { badPair = `${nameOf[id]}: βράδια ${ds[0]} & ${ds[1]} μη συνεχόμενα`; break; }
        }
      }
      if (badPair) break;
    }
    check('Βράδια: όταν είναι 2 την εβδομάδα, είναι ΣΥΝΕΧΟΜΕΝΑ (π.χ. Δευ+Τρι → ρεπό Τετ+Πεμ)', !badPair, badPair);

    // Ρεπό μετά το βράδυ (σε ΟΛΗ την περίοδο, με σύνορα): μετά από σειρά
    // Ν συνεχόμενων βραδιών → Ν μέρες χωρίς βάρδια
    const nightDates = new Map();
    const workDates = new Map();
    for (const wk of result.weeks) {
      for (const a of wk.assignments) {
        if (a.off) continue;
        if (!workDates.has(a.agentId)) workDates.set(a.agentId, new Set());
        workDates.get(a.agentId).add(a.date);
        if ((a.start === '23:00' || a.start === '23:30') && toMin(a.end) < toMin(a.start)) {
          if (!nightDates.has(a.agentId)) nightDates.set(a.agentId, []);
          nightDates.get(a.agentId).push(a.date);
        }
      }
    }
    let badRest = null;
    for (const [id, dates] of nightDates) {
      dates.sort();
      let i = 0;
      while (i < dates.length) {
        let len = 1;
        while (i + len < dates.length && dates[i + len] === addDays(dates[i + len - 1], 1)) len++;
        if (len > 2) { badRest = `${nameOf[id]}: ${len} συνεχόμενα βράδια`; break; }
        const last = dates[i + len - 1];
        for (let r = 1; r <= len; r++) {
          const rest = addDays(last, r);
          // εντός περιόδου μόνο
          if (rest <= result.weeks[result.weeks.length - 1].dates[6] && workDates.get(id).has(rest)) {
            badRest = `${nameOf[id]}: βράδυ έως ${last} (σειρά ${len}) αλλά δουλεύει ${rest}`;
            break;
          }
        }
        if (badRest) break;
        i += len;
      }
      if (badRest) break;
    }
    check('Βράδια: υποχρεωτικό ρεπό μετά (2 σερί βράδια → 2 σερί ρεπό), και στα σύνορα', !badRest, badRest);
  }

  // ---------- 10. 19:00-03:00 κάθε μέρα & Supervisors Δευ-Παρ (14/07/2026) ----------
  {
    let placed1903 = 0;
    let unc1903 = 0;
    let supUnc = 0;
    let supM = 0;
    let supA = 0;
    for (const wk of result.weeks) {
      for (const a of wk.assignments) {
        if (a.off) continue;
        if (a.start === '19:00' && a.end === '03:00') placed1903++;
        if (a.reqLabel === 'Supervisor' && a.start === '07:00') supM++;
        if (a.reqLabel === 'Supervisor' && a.start === '16:00') supA++;
      }
      for (const u of wk.report.uncovered) {
        if (u.start === '19:00') unc1903++;
        if (u.label === 'Supervisor') supUnc++;
      }
    }
    check(`19:00-03:00 κάθε μέρα Δευ-Κυρ: ${placed1903}/35 τοποθετημένες`, placed1903 + unc1903 === 35 && placed1903 >= 30, `placed=${placed1903} unc=${unc1903}`);
    // Ανοχή 1: σε εβδομάδες με σωρευμένες άδειες supervisors μπορεί μία
    // θέση να είναι δομικά αδύνατη (Κ2/Κ10 - η άδεια μετρά ως εργάσιμη) —
    // εμφανίζεται στην αναφορά για χειροκίνητη απόφαση
    check(`Supervisors ΚΑΘΕ μέρα Δευ-Κυρ 07:00-15:00 & 16:00-24:00 (${supM} πρωί / ${supA} απόγευμα, ακάλυπτα ${supUnc})`, supUnc <= 1 && supM >= 33 && supA >= 33, `unc=${supUnc} m=${supM} a=${supA}`);
  }

  // ---------- 10β. 19:00-03:00 ομαδοποίηση + ΣΚ International (15/07/2026) ----------
  {
    const { addDays } = require('../src/utils/dates');
    // Πολλαπλές 19:00-03:00/εβδομάδα: ΜΟΝΟ συνεχόμενες, και ρεπό μετά τη σειρά
    let bad = null;
    for (const wk of result.weeks) {
      const per = new Map();
      for (const a of wk.assignments) {
        if (!a.off && a.start === '19:00' && a.end === '03:00') {
          if (!per.has(a.agentId)) per.set(a.agentId, []);
          per.get(a.agentId).push(a.date);
        }
      }
      for (const [id, ds] of per) {
        if (ds.length < 2) continue;
        ds.sort();
        for (let i = 1; i < ds.length; i++) {
          if (ds[i] !== addDays(ds[i - 1], 1)) { bad = `${nameOf[id]}: 19:00 μη συνεχόμενες ${ds.join(',')}`; break; }
        }
        if (bad) break;
        const rest = addDays(ds[ds.length - 1], 1);
        const lastPeriodDate = result.weeks[result.weeks.length - 1].dates[6];
        if (rest <= lastPeriodDate) {
          const worksRest = result.weeks.some((w2) => w2.assignments.some((a) => a.agentId === id && a.date === rest && !a.off));
          if (worksRest) { bad = `${nameOf[id]}: δουλεύει ${rest} μετά από σειρά 19:00 (${ds.join(',')})`; break; }
        }
      }
      if (bad) break;
    }
    check('19:00-03:00: πολλαπλές = ΣΥΝΕΧΟΜΕΝΕΣ + ρεπό μετά τη σειρά', !bad, bad);

    // ΣΚ International: 2 slots/μέρα ΣΚ (πρωί+απόγευμα) λογαριασμένα
    let intPlaced = 0;
    let intUnc = 0;
    for (const wk of result.weeks) {
      for (const date of [wk.dates[5], wk.dates[6]]) {
        intPlaced += wk.assignments.filter((a) => !a.off && a.date === date && a.reqLabel === 'International').length;
      }
      for (const u of wk.report.uncovered) {
        const dow = dayOfWeek(u.date);
        if (dow >= 6 && u.label === 'International') intUnc++;
      }
    }
    check(`ΣΚ International 1 πρωί + 1 απόγευμα: ${intPlaced}/20 τοποθετημένα`, intPlaced + intUnc === 20 && intPlaced >= 16, `placed=${intPlaced} unc=${intUnc}`);
  }

  // ---------- 11. ΣΚ MAX = HARD (14/07/2026) ----------
  {
    // Ανά μέρα ΣΚ, ανά κατηγορία: μέγιστα 2 euro πρωί, 2 euro απόγ, 2 alpha
    // πρωί, 2 alpha απόγ, 1 Πειραιώς 06:00, 1 Πειραιώς απόγ, 1 verif πρωί,
    // 1 verif απόγ (+2 sup, 1×19:00, 1 νύχτα, καλοκαιρινά μοτίβα)
    const CAPS = [
      ['Eurobank πρωί', (x) => ['Eurobank', 'Eurobank (μόνο)'].includes(x.reqLabel) && x.start < '12:00', 2],
      ['Eurobank απόγευμα', (x) => ['Eurobank', 'Eurobank (μόνο)'].includes(x.reqLabel) && x.start >= '12:00' && x.start < '19:00', 2],
      ['Alpha πρωί', (x) => x.reqLabel === 'Alpha' && x.start < '12:00', 2],
      ['Alpha απόγευμα', (x) => x.reqLabel === 'Alpha' && x.start >= '12:00', 2],
      ['Πειραιώς 06:00', (x) => x.start === '06:00' && x.end === '14:00', 1],
      ['Πειραιώς απόγευμα', (x) => x.reqLabel === 'Πειραιώς' && x.start >= '12:00', 1],
      ['Verification πρωί', (x) => x.reqLabel === 'Verification' && x.start < '12:00', 1],
      ['Supervisor', (x) => x.reqLabel === 'Supervisor', 2]
    ];
    let bad = null;
    outerMax:
    for (const wk of result.weeks) {
      for (const date of [wk.dates[5], wk.dates[6]]) {
        const day = wk.assignments.filter((a) => !a.off && a.date === date);
        for (const [name, fn, cap] of CAPS) {
          const n = day.filter(fn).length;
          if (n > cap) { bad = `${date}: ${name} = ${n} (max ${cap})`; break outerMax; }
        }
      }
    }
    check('ΣΚ MAX (hard): κανένα ΣΚ πάνω από τα μέγιστα ανά κατηγορία', !bad, bad);

    // Και κανένας filler ΣΚ: όλες οι ΣΚ βάρδιες έχουν reqLabel ή είναι
    // δηλωμένες σταθερές (καλοκαιρινά μοτίβα Τσιτσικωστών = εντολή προϊσταμένου)
    const patternIds = new Set([idOf['ΤΣΙΤΣΙΚΩΣΤΑΣ ΑΛΕΞΑΝΔΡΟΣ'], idOf['ΤΣΙΤΣΙΚΩΣΤΑΣ ΛΕΩΝΙΔΑΣ']]);
    let extra = null;
    for (const wk of result.weeks) {
      for (const date of [wk.dates[5], wk.dates[6]]) {
        for (const a of wk.assignments) {
          if (a.off || a.date !== date) continue;
          if (patternIds.has(a.agentId)) continue; // σταθερό μοτίβο — δικαιολογημένο
          const isNight = (a.start === '23:00' || a.start === '23:30') && toMin(a.end) < toMin(a.start);
          if (!a.reqLabel && !isNight) { extra = `${date}: ${a.agentName} ${a.start}-${a.end} χωρίς απαίτηση`; break; }
        }
        if (extra) break;
      }
      if (extra) break;
    }
    check('ΣΚ MAX (hard): καμία βάρδια ΣΚ εκτός απαιτήσεων/σταθερών (κανένας filler)', !extra, extra);
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
