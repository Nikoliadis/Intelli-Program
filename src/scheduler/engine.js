// Ο αλγόριθμος δημιουργίας προγράμματος (ενότητα 8 του spec).
// Greedy με scoring, παραγωγή εβδομάδα-εβδομάδα με μεταφορά κατάστασης
// (συνεχόμενες μέρες Κ10, λήξη τελευταίας βάρδιας Κ8, μετρητές Σ3).
//
// Hard κανόνες: Κ1 skill/τμήμα, Κ2 1 βάρδια/μέρα & 5+2, Κ3 κανόνες agent,
// Κ4 νυχτερινή 23:00/23:30, Κ5 σταθερά ωράρια, Κ6 άδειες, Κ7 can_night,
// Κ8 11ωρο, Κ9 λίστα 19:00-03:00, Κ10 μέγιστο 5 συνεχόμενες μέρες.
// Soft: Σ1-Σ5 μέσω scoring + αναφορά παραβιάσεων.
const { toMin, dayNum, shiftAbs, isMorning, isAfternoon, isNight } = require('./time');
const { addDays, dayOfWeek } = require('../utils/dates');

const REST_MIN = 11 * 60; // Κ8: 11 ώρες ανάπαυση
// Εξαίρεση Κ8: το σπαστό του Κουλογιάννη (24:00 → 09:00 = 9 ώρες) είναι
// αποδεκτό επειδή προκύπτει από το ΔΗΛΩΜΕΝΟ σταθερό του ωράριο (Κ5).
const REST_MIN_SPLIT = 9 * 60;
const MAX_STREAK = 5; // Κ10

// Τυπικές βάρδιες για συμπλήρωση (όσοι δεν καλύπτουν συγκεκριμένη απαίτηση)
const FILLER_MORNING = [['08:00', '16:00'], ['09:00', '17:00'], ['07:30', '15:30'], ['10:00', '18:00']];
const FILLER_AFTERNOON = [['16:00', '24:00'], ['15:30', '23:30'], ['14:00', '22:00']];

// ---------- Βοηθητικά κανόνων ----------
function rule(agent, type) {
  return agent.rules.find((r) => r.type === type) || null;
}

function restMinFor(agent) {
  return rule(agent, 'split_shift') ? REST_MIN_SPLIT : REST_MIN;
}

// ---------- Η κατάσταση εβδομάδας ----------
// plan ανά agent: days[0..6] = null | {type:'off', reason} | {type:'work', ...}
function newWeek(ctx, weekStart, state) {
  const dates = [];
  for (let i = 0; i < 7; i++) dates.push(addDays(weekStart, i));

  const plans = new Map();
  for (const a of ctx.agents) {
    plans.set(a.id, {
      agent: a,
      days: new Array(7).fill(null),
      offNeeded: 2,
      leaveDays: 0,
      teleworkDays: 0,
      elig1903Used: 0
    });
  }
  return { ctx, weekStart, dates, plans, report: { uncovered: [], soft: [], notes: [] }, state };
}

function agentState(w, agentId) {
  if (!w.state[agentId]) {
    w.state[agentId] = { streak: 0, lastEndAbs: -Infinity, nights: 0, weekends: 0, count1903: 0, rizouMode: 'morning' };
  }
  return w.state[agentId];
}

function worked(plan, d) {
  return plan.days[d] && plan.days[d].type === 'work';
}

function assignedCount(plan) {
  return plan.days.filter((x) => x && x.type === 'work').length;
}

function workTarget(plan) {
  // Κ2: 5 εργάσιμες — μειωμένες κατά τις μέρες άδειας/ασθένειας
  return Math.max(0, 5 - plan.leaveDays);
}

// ---------- Έλεγχοι Κ8 / Κ10 ----------
// Απόλυτα λεπτά έναρξης/λήξης της καταχώρησης μιας μέρας
function entryAbs(w, plan, d) {
  const e = plan.days[d];
  if (!e || e.type !== 'work') return null;
  return shiftAbs(w.dates[d], e.start, e.end);
}

// Κ8: αρκετή ανάπαυση πριν και μετά αν μπει βάρδια start-end τη μέρα d
function k8ok(w, plan, d, start, end) {
  const rest = restMinFor(plan.agent);
  const { startAbs, endAbs } = shiftAbs(w.dates[d], start, end);
  const st = agentState(w, plan.agent.id);

  // Προηγούμενη λήξη: κοίτα πίσω μέσα στην εβδομάδα, αλλιώς την κατάσταση
  let prevEnd = -Infinity;
  for (let i = d - 1; i >= 0; i--) {
    const abs = entryAbs(w, plan, i);
    if (abs) { prevEnd = abs.endAbs; break; }
  }
  if (prevEnd === -Infinity) prevEnd = st.lastEndAbs;
  if (startAbs - prevEnd < rest && prevEnd !== -Infinity) return false;

  // Επόμενη έναρξη: ήδη τοποθετημένες μελλοντικές βάρδιες της εβδομάδας
  for (let i = d + 1; i < 7; i++) {
    const abs = entryAbs(w, plan, i);
    if (abs) {
      if (abs.startAbs - endAbs < rest) return false;
      break;
    }
  }
  return true;
}

// Κ10: αν δουλέψει τη μέρα d, η συνεχόμενη σειρά (με σύνορα εβδομάδων) ≤ 5
function k10ok(w, plan, d) {
  const st = agentState(w, plan.agent.id);
  // Πίσω
  let back = 0;
  for (let i = d - 1; i >= 0; i--) {
    if (worked(plan, i)) back++;
    else if (plan.days[i]) break; // ρεπό/άδεια κόβει τη σειρά
    else break; // κενό = δεν έχει (ακόμα) βάρδια — συντηρητικά κόβει
  }
  // Αν η σειρά φτάνει στη Δευτέρα, μετράει και το streak της προηγούμενης εβδομάδας
  if (back === d) back += st.streak;
  // Μπροστά
  let fwd = 0;
  for (let i = d + 1; i < 7; i++) {
    if (worked(plan, i)) fwd++;
    else break;
  }
  return back + 1 + fwd <= MAX_STREAK;
}

// Κ10 για την επιλογή ρεπό: με δεδομένα offs (σύνολο indexes) και υπόθεση
// εργασίας σε όλες τις άλλες μέρες, η μέγιστη σειρά ≤ 5;
function offsKeepStreakOk(offs, initialStreak) {
  let run = initialStreak;
  for (let d = 0; d < 7; d++) {
    if (offs.has(d)) {
      run = 0;
    } else {
      run++;
      if (run > MAX_STREAK) return false;
    }
  }
  return true;
}

// ---------- Έλεγχος κανόνων agent για συγκεκριμένη βάρδια ----------
// opts: { override1903: bool (Κ9 υπερισχύει ατομικών ωραρίων), telework: bool }
function shiftAllowedByRules(w, agent, d, start, end, opts = {}) {
  const dow = d + 1; // 1=Δευτέρα ... 7=Κυριακή
  const isWknd = dow >= 6;
  const s = toMin(start);
  const e = toMin(end) <= s ? toMin(end) + 1440 : toMin(end);

  for (const r of agent.rules) {
    switch (r.type) {
      case 'day_off_or_telework':
        // Τις μέρες του κανόνα: ΜΟΝΟ η τηλεργασία του κανόνα (αλλιώς ρεπό)
        if (r.days.includes(dow)) {
          if (!(start === r.shift[0] && end === r.shift[1])) return false;
          return true; // υπερισχύει των υπόλοιπων ελέγχων ωραρίου (πρωινό 06:00 κ.λπ.)
        }
        break;
      case 'only_morning':
        if (opts.override1903) break; // Κ9
        if (!isMorning(start, end)) return false;
        if (r.starts && !r.starts.includes(start)) return false;
        break;
      case 'only_afternoon':
        if (opts.override1903) break;
        if (!isAfternoon(start)) return false;
        break;
      case 'allowed_shifts':
        if (opts.override1903) break;
        if (!r.shifts.some(([rs, re]) => rs === start && re === end)) return false;
        break;
      case 'split_shift':
        // Μόνο το σπαστό τις μέρες του· τις άλλες μέρες ρεπό
        if (!r.days.includes(dow)) return false;
        if (!(start === r.parts[0][0] && end === r.parts[1][1])) return false;
        break;
      case 'weekdays_only':
        if (isWknd) return false;
        break;
      case 'morning_start_after':
        if (opts.override1903) break;
        if (isMorning(start, end) && s < toMin(r.time)) return false;
        break;
      case 'start_after':
        if (opts.override1903) break;
        if (s < toMin(r.time)) return false;
        break;
      case 'end_by':
        if (opts.override1903) break;
        if (e > toMin(r.time) + (toMin(r.time) <= s ? 1440 : 0)) return false;
        break;
      case 'afternoon_office_shift':
        // Απογευματινή από γραφείο μόνο με το συγκεκριμένο ωράριο
        if (opts.override1903) break;
        if (isAfternoon(start) && !opts.telework && !(start === r.shift[0] && end === r.shift[1])) return false;
        break;
      default:
        break; // soft κανόνες — δεν φιλτράρουν, μπαίνουν στο scoring
    }
  }

  // Νυχτερινές μόνο με can_night (Κ7) — η 19:00-03:00 εξαιρείται (Κ9)
  if (isNight(start, end) && !agent.canNight) return false;

  return true;
}

// Πλήρης έλεγχος τοποθέτησης
function canPlace(w, plan, d, start, end, opts = {}) {
  if (plan.days[d]) return false; // Κ2: 1 βάρδια/μέρα, όχι πάνω σε ρεπό/άδεια
  if (!opts.ignoreTarget && assignedCount(plan) >= workTarget(plan)) return false; // Κ2: 5 εργάσιμες
  if (!shiftAllowedByRules(w, plan.agent, d, start, end, opts)) return false;
  if (!k8ok(w, plan, d, start, end)) return false;
  if (!k10ok(w, plan, d)) return false;
  return true;
}

// Τοποθέτηση βάρδιας
function place(w, plan, d, obj) {
  plan.days[d] = { type: 'work', ...obj };
  if (obj.location === 'home') plan.teleworkDays++;
}

function markOff(w, plan, d, reason) {
  plan.days[d] = { type: 'off', reason };
}

// ---------- Χρώμα πρότασης για fillers ----------
function fillerColor(ctx, agent, d, start, end) {
  const dow = d + 1;
  const roles = ctx.roles;
  const get = (n) => (roles.get(n) ? { roleName: n, color: roles.get(n).color, roleId: roles.get(n).id } : { roleName: null, color: null, roleId: null });

  if (agent.departments.includes('supervisor')) return get('Supervisor');
  if (rule(agent, 'heron_weekdays') && dow <= 5) return get('Ήρων');
  if (agent.skills.has('ΗΡΩΝ') && !agent.skills.has('EUROBANK')) return get('Ήρων');
  if (agent.departments.includes('verification')) return get('Verification');
  if (agent.skills.has('ΠΕΙΡΑΙΩΣ') && start === '06:00') return get('Πειραιώς');
  if (agent.skills.has('EUROBANK')) return get('Eurobank');
  return get('Υπόλοιπα call');
}

// ==================== ΦΑΣΕΙΣ ΕΒΔΟΜΑΔΑΣ ====================

// Φάση 1: άδειες/αιτήματα ρεπό (Κ6) + σταθερά ρεπό + σταθερά ωράρια (Κ5)
function phaseLock(w) {
  const { ctx } = w;
  for (const a of ctx.agents) {
    const plan = w.plans.get(a.id);

    for (let d = 0; d < 7; d++) {
      const t = ctx.timeOff.get(`${a.id}|${w.dates[d]}`);
      if (t === 'leave' || t === 'sick') {
        markOff(w, plan, d, t);
        plan.leaveDays++;
      } else if (t === 'repo_request') {
        markOff(w, plan, d, 'repo_request');
        plan.offNeeded--;
      }
    }

    // Σταθερά ρεπό (π.χ. Αγγελούδη Δευ+Τρι, Τσιτσικώστας Αλ. Τετ+Πεμ)
    for (const dow of a.fixedDaysOff) {
      const d = dow - 1;
      if (!plan.days[d]) {
        markOff(w, plan, d, 'fixed_off');
        plan.offNeeded--;
      }
    }

    // weekdays_only / split_shift: τα ΣΚ είναι πάντα ρεπό
    if (rule(a, 'weekdays_only') || rule(a, 'split_shift') || (a.fixedDays && !a.fixedDays.includes(6) && !a.fixedDays.includes(7))) {
      for (const d of [5, 6]) {
        if (!plan.days[d]) {
          markOff(w, plan, d, 'fixed_off');
          plan.offNeeded--;
        }
      }
    }
    plan.offNeeded = Math.max(0, plan.offNeeded);

    // Σταθερά ωράρια σε σταθερές μέρες (Κ5)
    if (a.fixedStart && a.fixedDays) {
      for (const dow of a.fixedDays) {
        const d = dow - 1;
        if (plan.days[d]) continue; // άδεια/ρεπό υπερισχύει (Κ6)
        if (assignedCount(plan) >= workTarget(plan)) break;
        const c = fillerColor(ctx, a, d, a.fixedStart, a.fixedEnd);
        place(w, plan, d, {
          start: a.fixedStart, end: a.fixedEnd,
          label: a.workLocation === 'home' ? 'ΤΗΛΕΡΓΑΣΙΑ' : null,
          location: a.workLocation, fixed: true, ...c
        });
      }
    }

    // Σπαστό ωράριο Κουλογιάννη: 09:00-24:00 με parts (μία «βάρδια» τη μέρα)
    const sp = rule(a, 'split_shift');
    if (sp) {
      for (const dow of sp.days) {
        const d = dow - 1;
        if (plan.days[d]) continue;
        if (assignedCount(plan) >= workTarget(plan)) break;
        const c = fillerColor(ctx, a, d, sp.parts[0][0], sp.parts[1][1]);
        place(w, plan, d, {
          start: sp.parts[0][0], end: sp.parts[1][1],
          parts: sp.parts, label: 'ΣΠΑΣΤΟ', location: a.workLocation, fixed: true, ...c
        });
      }
    }

    // Βάρδια ΣΚ Αγγελούδη (16:00-24:00) — Κ5
    if (a.weekendShift) {
      const [ws, we] = a.weekendShift.split('-');
      for (const d of [5, 6]) {
        if (plan.days[d]) continue;
        if (assignedCount(plan) >= workTarget(plan)) break;
        const c = fillerColor(ctx, a, d, ws, we);
        place(w, plan, d, { start: ws, end: we, location: a.workLocation, fixed: true, ...c });
      }
    }
  }
}

// Φάση 2: Σ1 — Παρασκευή 06:00-14:00 Πειραιώς Νικολιάδης + Νικολιάδη Αλίκη
function phaseS1(w) {
  const { ctx } = w;
  const pair = ctx.agents.filter((a) => rule(a, 'day_off_or_telework'));
  if (pair.length === 0) return;
  const FRI = 4;
  const piraeus = ctx.roles.get('Πειραιώς') || { id: null, color: null };

  const placeable = pair.filter((a) => {
    const plan = w.plans.get(a.id);
    const r = rule(a, 'day_off_or_telework');
    return r.days.includes(5) && canPlace(w, plan, FRI, r.shift[0], r.shift[1], { telework: true });
  });

  const doPlace = (a) => {
    const r = rule(a, 'day_off_or_telework');
    place(w, w.plans.get(a.id), FRI, {
      start: r.shift[0], end: r.shift[1],
      skill: 'ΠΕΙΡΑΙΩΣ', label: 'ΤΗΛΕΡΓΑΣΙΑ', location: 'home',
      roleName: 'Πειραιώς', roleId: piraeus.id, color: piraeus.color, s1: true
    });
  };

  if (placeable.length === 2) {
    placeable.forEach(doPlace);
  } else if (placeable.length === 1) {
    doPlace(placeable[0]);
    w.report.soft.push(`Σ1: μόνο ο/η ${placeable[0].name} μπόρεσε να μπει Παρασκευή 06:00-14:00 Πειραιώς — ο άλλος παίρνει ρεπό.`);
  } else if (pair.length === 2) {
    w.report.soft.push('Σ1: δεν βγήκε Παρασκευή 06:00-14:00 Πειραιώς για Νικολιάδη/Νικολιάδη Αλίκη.');
  }

  // Οι υπόλοιπες «μέρες κανόνα» (Δευ/Τρι/Παρ) που δεν έγιναν τηλεργασία → ρεπό
  for (const a of pair) {
    const plan = w.plans.get(a.id);
    const r = rule(a, 'day_off_or_telework');
    for (const dow of r.days) {
      const d = dow - 1;
      if (!plan.days[d]) {
        markOff(w, plan, d, 'rule');
        plan.offNeeded--;
      }
    }
    plan.offNeeded = Math.max(0, plan.offNeeded);
  }
}

// Φάση 3: Νυχτερινές 23:00/23:30 (Κ4, Κ7) — μόνο Νομικού + Μαυραγάνη
// (απόφαση προϊσταμένου 09/07/2026), εναλλαγή με μετρητή Σ3.
function phaseNights(w, nightReqByDay) {
  const { ctx } = w;
  const pool = ctx.agents.filter((a) => a.canNight && a.skills.has('EUROBANK'));
  const euro = ctx.roles.get('Eurobank') || { id: null, color: null };

  for (let d = 0; d < 7; d++) {
    if (!nightReqByDay[d]) continue;
    // Προτίμηση: όχι night_last_resort, λιγότερες νύχτες ιστορικά (Σ3)
    const cands = pool
      .filter((a) => canPlace(w, w.plans.get(a.id), d, '23:30', '07:30'))
      .sort((x, y) => {
        const lrX = rule(x, 'night_last_resort') ? 1 : 0;
        const lrY = rule(y, 'night_last_resort') ? 1 : 0;
        if (lrX !== lrY) return lrX - lrY;
        return agentState(w, x.id).nights - agentState(w, y.id).nights;
      });

    if (cands.length === 0) {
      w.report.uncovered.push({ date: w.dates[d], start: '23:00', end: '07:00', label: 'Νυχτερινή Eurobank' });
      continue;
    }
    const a = cands[0];
    if (rule(a, 'night_last_resort')) {
      w.report.soft.push(`Νυχτερινή ${w.dates[d]}: ${a.name} από ανάγκη (soft αποφυγή).`);
    }
    // Κ4: προσωρινά 23:30-07:30 — οριστικοποιείται σε post-pass βάσει του
    // ποιος πραγματικά ανοίγει το επόμενο πρωί στις 07:00/07:30
    place(w, w.plans.get(a.id), d, {
      start: '23:30', end: '07:30', skill: 'EUROBANK', label: 'ΝΥΧΤΕΡΙΝΗ',
      location: 'office', night: true, roleName: 'Eurobank', roleId: euro.id, color: euro.color,
      reqLabel: 'Νυχτερινή Eurobank'
    });
    nightReqByDay[d].covered++;
    agentState(w, a.id).nights++;
  }
}

// Φάση 4: κατανομή ρεπό (Σ2 συνεχόμενα, Σ3 εξισορρόπηση ΣΚ, Κ10 στα σύνορα).
// Κρίσιμο: τα ρεπό πρέπει να μοιράζονται ώστε ΚΑΘΕ μέρα (ιδίως τα ΣΚ) να
// μένουν αρκετοί διαθέσιμοι επιλέξιμοι για κάθε απαίτηση κάλυψης.
function phaseOffs(w) {
  const { ctx } = w;

  const eligibleFor = (agent, r) =>
    (!r.department || agent.departments.includes(r.department)) &&
    (!r.skill || agent.skills.has(r.skill));

  // Πόσο θα «πονέσει» η μέρα d αν πάρει ρεπό ο agent: αν οι εναπομείναντες
  // διαθέσιμοι επιλέξιμοι πέσουν κοντά/κάτω από το headcount μιας απαίτησης,
  // τεράστια ποινή. Υπολογίζεται ΔΥΝΑΜΙΚΑ πάνω στο τρέχον πλάνο.
  function dayRisk(agent, d) {
    const dow = d + 1;
    const reqs = ctx.requirements[dow >= 6 ? 'weekend' : 'weekday'];
    let risk = 0;
    for (const r of reqs) {
      if (!eligibleFor(agent, r)) continue;
      // Διαθέσιμοι = επιλέξιμοι που ΔΕΝ έχουν ρεπό/άδεια τη μέρα d
      let avail = 0;
      for (const x of ctx.agents) {
        if (!eligibleFor(x, r)) continue;
        const e = w.plans.get(x.id).days[d];
        if (!e || e.type === 'work') avail++;
      }
      const after = avail - 1;
      if (after < r.headcount) risk += 200; // θα μείνει ακάλυπτο σχεδόν σίγουρα
      else if (after < r.headcount + 2) risk += 40; // οριακό — απόφυγέ το
      else risk += 6 / after;
    }
    return risk;
  }

  // Πόσα ρεπό έχουν ήδη δοθεί τη μέρα d (εξισορρόπηση φόρτου ημέρας)
  function offLoad(d) {
    let n = 0;
    for (const a of ctx.agents) {
      const e = w.plans.get(a.id).days[d];
      if (e && e.type === 'off') n++;
    }
    return n;
  }

  // Λιγότερο ευέλικτοι πρώτοι (λίγες ελεύθερες μέρες)
  const order = [...ctx.agents].sort((x, y) => {
    const fx = w.plans.get(x.id).days.filter((e) => !e).length;
    const fy = w.plans.get(y.id).days.filter((e) => !e).length;
    return fx - fy;
  });

  for (const a of order) {
    const plan = w.plans.get(a.id);
    while (plan.offNeeded > 0) {
      const st = agentState(w, a.id);
      const free = [];
      for (let d = 0; d < 7; d++) if (!plan.days[d]) free.push(d);
      if (free.length === 0) break;

      // Υποψήφια σύνολα: ζεύγη συνεχόμενων (Σ2) όταν χρειάζονται 2, αλλιώς μονά
      const options = [];
      if (plan.offNeeded >= 2) {
        for (let i = 0; i < free.length - 1; i++) {
          if (free[i + 1] === free[i] + 1) options.push([free[i], free[i] + 1]);
        }
      }
      for (const d of free) options.push([d]);

      let best = null;
      let bestScore = -Infinity;
      for (const opt of options) {
        // Κ10: με αυτά τα ρεπό (και όσα ήδη υπάρχουν) κόβεται κάθε 6άρι;
        const offs = new Set(opt);
        for (let d = 0; d < 7; d++) if (plan.days[d] && plan.days[d].type === 'off') offs.add(d);
        if (opt.some((d) => plan.days[d])) continue;
        if (!offsKeepStreakOk(offs, st.streak)) continue;

        let score = 0;
        if (opt.length === 2) score += rule(a, 'consecutive_off_strong') ? 40 : 12; // Σ2
        // Σ3: όποιος έχει δουλέψει πολλά ΣΚ, να ξεκουράζεται ΣΚ
        const wkndDays = opt.filter((d) => d >= 5).length;
        score += wkndDays * Math.min(st.weekends, 6) * 2;
        for (const d of opt) {
          score -= dayRisk(a, d); // μη «κάψεις» σπάνιο πόρο
          score -= offLoad(d) * 2; // ισοκατανομή ρεπό στις μέρες
        }
        if (score > bestScore) { bestScore = score; best = opt; }
      }

      if (!best) {
        // Δεν βρέθηκε έγκυρο σύνολο — πάρε την πρώτη ελεύθερη μέρα που κόβει σειρά
        best = [free[0]];
      }
      for (const d of best) {
        markOff(w, plan, d, 'repo');
        plan.offNeeded--;
      }
    }
  }
}

// Φάση 5: κάλυψη απαιτήσεων (Κ1) με scoring
function phaseRequirements(w, reqByDay) {
  const { ctx } = w;

  for (let d = 0; d < 7; d++) {
    for (const rq of reqByDay[d]) {
      if (rq.def.start === '23:00') continue; // νυχτερινή: καλύφθηκε στη φάση 3
      if (rq.def.start === '19:00') continue; // 19:00-03:00: φάση 6 (Κ9)

      // 1) Μετρά ήδη τοποθετημένες βάρδιες που ταιριάζουν (σταθερά ωράρια Κ5,
      //    ΣΚ Αγγελούδη κ.λπ.)
      for (const a of ctx.agents) {
        if (rq.covered >= rq.def.headcount) break;
        const plan = w.plans.get(a.id);
        const e = plan.days[d];
        if (!e || e.type !== 'work' || e.usedForReq) continue;
        if (rq.def.department && !a.departments.includes(rq.def.department)) continue;
        if (rq.def.skill && !a.skills.has(rq.def.skill)) continue;
        const exact = e.start === rq.def.start && e.end === rq.def.end;
        // Αγγελούδη ΣΚ 16:00-24:00 μετράει ως απογευματινός Supervisor
        // (απόφαση προϊσταμένου 09/07/2026)
        const wkndSup = d >= 5 && rq.def.department === 'supervisor' &&
          rq.def.start === '15:00' && e.start === '16:00' && e.end === '24:00';
        if (exact || wkndSup) {
          e.usedForReq = true;
          e.reqLabel = rq.def.label;
          if (!e.color && rq.def.color) { e.color = rq.def.color; e.roleId = rq.def.roleId; }
          rq.covered++;
        }
      }

      // 2) Νέες τοποθετήσεις για ό,τι λείπει
      while (rq.covered < rq.def.headcount) {
        const cands = [];
        for (const a of ctx.agents) {
          if (rq.def.department && !a.departments.includes(rq.def.department)) continue;
          if (rq.def.skill && !a.skills.has(rq.def.skill)) continue;
          const plan = w.plans.get(a.id);
          const telework = a.workLocation === 'home';
          if (!canPlace(w, plan, d, rq.def.start, rq.def.end, { telework })) continue;

          // Scoring
          let score = 100;
          const st = agentState(w, a.id);
          // Σ4: συνέπεια ωραρίου μέσα στην εβδομάδα
          for (let i = 0; i < 7; i++) {
            const e = plan.days[i];
            if (e && e.type === 'work' && e.start === rq.def.start) score += 6;
            else if (e && e.type === 'work' && isMorning(e.start, e.end) !== isMorning(rq.def.start, rq.def.end)) score -= 5;
          }
          // Προτεραιότητα σε όσους απέχουν από τον στόχο 5 ημερών
          score += (workTarget(plan) - assignedCount(plan)) * 4;
          // Σ3: λιγότερα ΣΚ ιστορικά → προτεραιότητα το ΣΚ
          if (d >= 5) score -= Math.min(st.weekends, 10) * 2;
          // Προτιμήσεις πρωί/απόγευμα (soft)
          if (rule(a, 'prefer_morning')) score += isMorning(rq.def.start, rq.def.end) ? 5 : -6;
          if (rule(a, 'prefer_afternoon')) score += isAfternoon(rq.def.start) ? 5 : -6;
          // Διατήρηση ευελιξίας: όσοι μπορούν ΜΟΝΟ αυτό το είδος βάρδιας
          // προηγούνται, ώστε οι ευέλικτοι να μένουν για τις υπόλοιπες
          if (isMorning(rq.def.start, rq.def.end) && rule(a, 'only_morning')) score += 14;
          if (isAfternoon(rq.def.start) && (rule(a, 'only_afternoon') || rule(a, 'allowed_shifts'))) score += 14;
          // Eurobank μόνο σε απόλυτη ανάγκη (Δεληκωστοπούλου)
          if (rq.def.skill && rule(a, 'skill_last_resort') && rule(a, 'skill_last_resort').skill === rq.def.skill) score -= 60;
          // ΗΡΩΝ τις καθημερινές: μείνε στον ΗΡΩΝ, όχι σε άλλες απαιτήσεις
          if (rule(a, 'heron_weekdays') && d < 5) score -= 30;
          // Μπακούλης: όταν απογευματινή διά ζώσης → 15:30-23:30 International
          const asi = rule(a, 'afternoon_shift_international');
          if (asi && isAfternoon(rq.def.start)) {
            score += rq.def.start === asi.shift[0] && rq.def.label === 'International' ? 15 : -15;
          }
          // Ρίζου: εναλλαγή πρωί/απόγευμα ανά εβδομάδα
          if (rule(a, 'weekly_alternation')) {
            const wantMorning = agentState(w, a.id).rizouMode === 'morning';
            if (isMorning(rq.def.start, rq.def.end) !== wantMorning) score -= 50;
          }
          // Νυχτερινοί (Νομικού/Μαυραγάνη): κράτα τους για τις νύχτες
          if (a.canNight && a.skills.has('EUROBANK')) score -= 8;

          cands.push({ a, score });
        }

        if (cands.length === 0) {
          w.report.uncovered.push({ date: w.dates[d], start: rq.def.start, end: rq.def.end, label: rq.def.label });
          break;
        }
        cands.sort((x, y) => y.score - x.score || x.a.id - y.a.id);
        const a = cands[0].a;
        const telework = a.workLocation === 'home';
        place(w, w.plans.get(a.id), d, {
          start: rq.def.start, end: rq.def.end,
          skill: rq.def.skill, reqLabel: rq.def.label, usedForReq: true,
          label: [telework ? 'ΤΗΛΕΡΓΑΣΙΑ' : null, rq.def.label === 'International' ? 'INTERNATIONAL' : null].filter(Boolean).join(' ') || null,
          location: telework ? 'home' : 'office',
          roleName: rq.def.color ? null : undefined, roleId: rq.def.roleId, color: rq.def.color
        });
        rq.covered++;
      }
    }
  }
}

// Φάση 6: βάρδια 19:00-03:00 (Κ9 — μόνο λίστα, όρια/εβδομάδα, Αγγελή όχι μόνη)
function phase1903(w, reqByDay) {
  const { ctx } = w;
  const verif = ctx.roles.get('Verification') || { id: null, color: null };

  // Διαστήματα παρουσίας στο γραφείο για τη μέρα d στο [19:00, 03:00+]
  function officeCover(d, exceptAgentId) {
    const iv = [];
    for (const a of ctx.agents) {
      if (a.id === exceptAgentId) continue;
      const plan = w.plans.get(a.id);
      const e = plan.days[d];
      if (e && e.type === 'work' && e.location !== 'home') {
        const s = toMin(e.start);
        const en = toMin(e.end) <= s ? toMin(e.end) + 1440 : toMin(e.end);
        if (e.parts) {
          for (const [ps, pe] of e.parts) {
            const pss = toMin(ps);
            const pee = toMin(pe) <= pss ? toMin(pe) + 1440 : toMin(pe);
            iv.push([pss, pee]);
          }
        } else {
          iv.push([s, en]);
        }
      }
      // Νυχτερινή που ξεκίνησε την ΙΔΙΑ μέρα d καλύπτει έως το πρωί
    }
    return iv;
  }

  function coveredContinuously(iv, from, to) {
    // Ελέγχει ότι το [from,to] καλύπτεται συνεχόμενα από την ένωση των iv
    let point = from;
    const sorted = iv.filter(([s, e]) => e > from && s < to).sort((a, b) => a[0] - b[0]);
    for (const [s, e] of sorted) {
      if (s > point) return false;
      point = Math.max(point, e);
      if (point >= to) return true;
    }
    return point >= to;
  }

  for (let d = 0; d < 5; d++) { // μόνο καθημερινές
    const rq = reqByDay[d].find((r) => r.def.start === '19:00');
    if (!rq || rq.covered >= rq.def.headcount) continue;

    const cands = [];
    for (const a of ctx.agents) {
      const el = ctx.eligibility.get(a.id);
      if (!el) continue; // Κ9: ΜΟΝΟ από τη λίστα
      const plan = w.plans.get(a.id);
      if (plan.elig1903Used >= el.maxPerWeek) continue;
      // Κ9 υπερισχύει ατομικών περιορισμών ωραρίου — όχι όμως των Κ2/Κ6/Κ8/Κ10
      if (!canPlace(w, plan, d, '19:00', '03:00', { override1903: true })) continue;
      // Αγγελή: όχι μόνη στο γραφείο σε ΚΑΜΙΑ ώρα της βάρδιας
      if (el.notAlone && el.location === 'office') {
        const iv = officeCover(d, a.id);
        if (!coveredContinuously(iv, toMin('19:00'), toMin('19:00') + 8 * 60)) continue;
      }
      const st = agentState(w, a.id);
      let score = 100 - st.count1903 * 5 - plan.elig1903Used * 20;
      // Ρίζου: προτίμησέ την τις εβδομάδες απογεύματος
      if (rule(a, 'weekly_alternation') && st.rizouMode === 'morning') score -= 25;
      score += (workTarget(plan) - assignedCount(plan)) * 4;
      cands.push({ a, el, score });
    }

    if (cands.length === 0) {
      w.report.uncovered.push({ date: w.dates[d], start: '19:00', end: '03:00', label: rq.def.label });
      continue;
    }
    cands.sort((x, y) => y.score - x.score || x.a.id - y.a.id);
    const { a, el } = cands[0];
    const plan = w.plans.get(a.id);
    place(w, plan, d, {
      start: '19:00', end: '03:00', skill: rq.def.skill, reqLabel: rq.def.label, usedForReq: true,
      label: el.location === 'home' ? 'ΤΗΛΕΡΓΑΣΙΑ' : null,
      location: el.location, roleId: verif.id, color: verif.color
    });
    plan.elig1903Used++;
    agentState(w, a.id).count1903++;
    rq.covered++;
  }
}

// Φάση 7: συμπλήρωση — ΟΛΟΙ οι ενεργοί φτάνουν τις 5 εργάσιμες (Κ2,
// απόφαση προϊσταμένου 09/07/2026), με λογική βάρδια βάσει κανόνων/Σ4.
function phaseFillers(w) {
  const { ctx } = w;
  for (const a of ctx.agents) {
    const plan = w.plans.get(a.id);

    for (let d = 0; d < 7 && assignedCount(plan) < workTarget(plan); d++) {
      if (plan.days[d]) continue;

      // Υποψήφιες βάρδιες με σειρά προτίμησης
      let shifts = [];
      if (a.fixedStart && !a.fixedDays) {
        shifts = [[a.fixedStart, a.fixedEnd]]; // π.χ. Σταθοπούλου 16:00-24:00
      } else {
        const alt = rule(a, 'weekly_alternation');
        const wantMorning =
          rule(a, 'only_morning') ? true :
          rule(a, 'only_afternoon') || rule(a, 'allowed_shifts') ? false :
          alt ? agentState(w, a.id).rizouMode === 'morning' :
          rule(a, 'prefer_afternoon') ? false :
          rule(a, 'prefer_morning') ? true :
          // Σ4: ακολούθησε ό,τι κάνει ήδη μέσα στην εβδομάδα
          plan.days.some((e) => e && e.type === 'work' && isAfternoon(e.start)) ? false : true;

        const allowed = rule(a, 'allowed_shifts');
        if (allowed) {
          shifts = allowed.shifts;
        } else {
          shifts = wantMorning ? [...FILLER_MORNING, ...FILLER_AFTERNOON] : [...FILLER_AFTERNOON, ...FILLER_MORNING];
        }
        // only_morning με συγκεκριμένες ενάρξεις (Αλίκη 07:30/08:00)
        const om = rule(a, 'only_morning');
        if (om && om.starts) shifts = FILLER_MORNING.filter(([s]) => om.starts.includes(s));
      }

      for (const [s, e] of shifts) {
        const telework = a.workLocation === 'home';
        if (canPlace(w, plan, d, s, e, { telework })) {
          const c = fillerColor(ctx, a, d, s, e);
          place(w, plan, d, {
            start: s, end: e,
            label: telework ? 'ΤΗΛΕΡΓΑΣΙΑ' : null,
            location: telework ? 'home' : 'office',
            filler: true, ...c
          });
          break;
        }
      }
    }

    // Όσες μέρες έμειναν κενές μετά τον στόχο → ρεπό (πέρα από τα 2 = σημείωση)
    let extraOff = 0;
    for (let d = 0; d < 7; d++) {
      if (!plan.days[d]) {
        markOff(w, plan, d, assignedCount(plan) < workTarget(plan) ? 'repo' : 'repo');
        extraOff++;
      }
    }
    const deficit = workTarget(plan) - assignedCount(plan);
    if (deficit > 0) {
      w.report.soft.push(`${a.name}: μόνο ${assignedCount(plan)}/${workTarget(plan)} εργάσιμες — δεν βρέθηκε επιτρεπτή βάρδια για ${deficit} μέρα/ες.`);
    }
  }
}

// Φάση 8: Κ4 — οριστικοποίηση ώρας νυχτερινής (23:00 ή 23:30)
function phaseK4(w) {
  const { ctx } = w;
  for (let d = 0; d < 7; d++) {
    for (const a of ctx.agents) {
      const plan = w.plans.get(a.id);
      const e = plan.days[d];
      if (!e || e.type !== 'work' || !e.night) continue;

      // Ανοίγει κάποιος στις 07:00/07:30 την επόμενη μέρα;
      let opener = false;
      if (d < 6) {
        for (const b of ctx.agents) {
          const ne = w.plans.get(b.id).days[d + 1];
          if (ne && ne.type === 'work' && (ne.start === '07:00' || ne.start === '07:30')) {
            opener = true;
            break;
          }
        }
      } else {
        opener = true; // Κυριακή: το πρωί της Δευτέρας έχει πάντα Supervisor 07:00 — αναθεωρείται στην επόμενη εβδομάδα αν χρειαστεί
      }

      if (!opener) {
        // Κανείς νωρίς το πρωί → η νυχτερινή ανοίγει η ίδια στις 23:00-07:00
        // (έλεγχος Κ8 προς τα πίσω για την κατά 30' νωρίτερη έναρξη)
        const old = plan.days[d];
        plan.days[d] = null;
        if (canPlace(w, plan, d, '23:00', '07:00', { ignoreTarget: true })) {
          plan.days[d] = { ...old, start: '23:00', end: '07:00' };
        } else {
          plan.days[d] = old;
        }
      }
    }
  }
}

// Φάση 9: soft έλεγχοι Σ5 (ίδια ώρα έναρξης ζεύγους) → αναφορά
function phasePairReport(w) {
  const { ctx } = w;
  const seen = new Set();
  for (const a of ctx.agents) {
    const pr = rule(a, 'pair_same_start');
    if (!pr || seen.has(a.name)) continue;
    const b = ctx.agents.find((x) => x.name === pr.with);
    if (!b) continue;
    seen.add(a.name);
    seen.add(b.name);
    for (let d = 0; d < 7; d++) {
      const ea = w.plans.get(a.id).days[d];
      const eb = w.plans.get(b.id).days[d];
      if (ea && eb && ea.type === 'work' && eb.type === 'work' && ea.start !== eb.start) {
        w.report.soft.push(`Σ5: ${w.dates[d]} διαφορετική έναρξη ${a.name} (${ea.start}) / ${b.name} (${eb.start}).`);
      }
    }
  }
}

// Τελική κατάσταση εβδομάδας → αρχική της επόμενης
function computeNextState(w) {
  const { ctx } = w;
  const next = {};
  for (const a of ctx.agents) {
    const plan = w.plans.get(a.id);
    const st = agentState(w, a.id);

    // Streak: συνεχόμενες εργάσιμες μέχρι και την Κυριακή
    let streak = 0;
    for (let d = 6; d >= 0; d--) {
      if (worked(plan, d)) streak++;
      else break;
    }
    if (streak === 7) streak += st.streak; // ολόκληρη εβδομάδα δουλεμένη (θεωρητικά αδύνατο με Κ2)

    // Λήξη τελευταίας βάρδιας
    let lastEndAbs = st.lastEndAbs;
    for (let d = 0; d < 7; d++) {
      const abs = entryAbs(w, plan, d);
      if (abs) lastEndAbs = Math.max(lastEndAbs, abs.endAbs);
    }

    // ΣΚ που δούλεψε
    let wknd = 0;
    for (const d of [5, 6]) if (worked(plan, d)) wknd++;

    next[a.id] = {
      streak,
      lastEndAbs,
      nights: st.nights,
      weekends: st.weekends + wknd,
      count1903: st.count1903,
      rizouMode: rule(a, 'weekly_alternation')
        ? (assignedCount(plan) > 0 ? (st.rizouMode === 'morning' ? 'afternoon' : 'morning') : st.rizouMode)
        : st.rizouMode
    };
  }
  return next;
}

// Εξαγωγή αναθέσεων εβδομάδας σε επίπεδη λίστα (για DB/preview/export)
function exportAssignments(w) {
  const out = [];
  for (const a of w.ctx.agents) {
    const plan = w.plans.get(a.id);
    for (let d = 0; d < 7; d++) {
      const e = plan.days[d];
      if (!e) continue;
      if (e.type === 'off') {
        out.push({ agentId: a.id, agentName: a.name, date: w.dates[d], off: true, reason: e.reason });
      } else if (e.parts) {
        for (const [ps, pe] of e.parts) {
          out.push({
            agentId: a.id, agentName: a.name, date: w.dates[d],
            start: ps, end: pe, skill: e.skill || null, label: e.label,
            reqLabel: e.reqLabel || null, color: e.color || null, roleId: e.roleId || null,
            location: e.location || 'office'
          });
        }
      } else {
        out.push({
          agentId: a.id, agentName: a.name, date: w.dates[d],
          start: e.start, end: e.end, skill: e.skill || null, label: e.label || null,
          reqLabel: e.reqLabel || null, color: e.color || null, roleId: e.roleId || null,
          location: e.location || 'office', night: e.night || false
        });
      }
    }
  }
  return out;
}

// ==================== ΚΥΡΙΑ ΣΥΝΑΡΤΗΣΗ ΕΒΔΟΜΑΔΑΣ ====================
function generateWeek(ctx, weekStart, state) {
  const w = newWeek(ctx, weekStart, state);

  // Απαιτήσεις ανά μέρα με μετρητή κάλυψης
  const reqByDay = [];
  const nightReqByDay = [];
  for (let d = 0; d < 7; d++) {
    const defs = ctx.requirements[d >= 5 ? 'weekend' : 'weekday'];
    reqByDay.push(defs.map((def) => ({ def, covered: 0 })));
    nightReqByDay.push(reqByDay[d].find((r) => r.def.start === '23:00') || null);
  }

  phaseLock(w);          // Κ5, Κ6, σταθερά ρεπό
  phaseS1(w);            // Σ1 + κανόνες σχολής (Κ3)
  phaseNights(w, nightReqByDay); // Κ4, Κ7, Σ3
  phaseOffs(w);          // ρεπό: Σ2, Σ3, Κ10
  phaseRequirements(w, reqByDay); // Κ1 με scoring
  phase1903(w, reqByDay); // Κ9
  phaseFillers(w);       // Κ2: όλοι στις 5 εργάσιμες
  phaseK4(w);            // οριστικοποίηση 23:00/23:30
  phasePairReport(w);    // Σ5 αναφορά

  const nextState = computeNextState(w);
  return {
    weekStart,
    dates: w.dates,
    assignments: exportAssignments(w),
    report: w.report,
    nextState
  };
}

module.exports = { generateWeek };
