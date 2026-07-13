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

// Έλεγχος τμήματος απαίτησης: 'verification+call' σημαίνει ότι ο agent
// πρέπει να έχει ΚΑΙ τα δύο τμήματα (π.χ. Verification & call slots —
// απόφαση προϊσταμένου 10/07/2026: τα κάνει ΜΟΝΟ όποιος έχει ταμπέλα call).
function deptMatch(agent, department) {
  if (!department) return true;
  return department.split('+').every((d) => agent.departments.includes(d));
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
    w.state[agentId] = { streak: 0, lastEndAbs: -Infinity, nights: 0, weekends: 0, count1903: 0, count62: 0, rizouMode: 'morning', sundays: {}, pendingNightRest: 0 };
  }
  return w.state[agentId];
}

// Εξαίρεση από το όριο Κυριακών: supervisors και όσοι έχουν σταθερό
// πρόγραμμα (σταθερό ωράριο με μέρες, σταθερή βάρδια ΣΚ όπως η Αγγελούδη,
// ή καλοκαιρινό weekly_pattern όπως οι Τσιτσικώστες)
function sundayExempt(agent) {
  return agent.departments.includes('supervisor') ||
    !!agent.weekendShift ||
    (agent.fixedStart && agent.fixedDays) ||
    !!rule(agent, 'weekly_pattern');
}

function worked(plan, d) {
  return plan.days[d] && plan.days[d].type === 'work';
}

// Η ΑΔΕΙΑ/ΑΣΘΕΝΕΙΑ μετράει ως ΕΡΓΑΣΙΜΗ μέρα για το Κ10 (13/07/2026):
// συνεχίζει τη σειρά συνεχόμενων ημερών — μετά από 5 μέρες άδειας
// χρειάζεται ΡΕΠΟ, όχι βάρδια. Μόνο το ρεπό κόβει τη σειρά.
function countsAsWork(plan, d) {
  const e = plan.days[d];
  if (!e) return false;
  if (e.type === 'work') return true;
  return e.reason === 'leave' || e.reason === 'sick';
}

function assignedCount(plan) {
  return plan.days.filter((x) => x && x.type === 'work').length;
}

function workTarget(plan) {
  // Καλοκαιρινά weekly_pattern (Τσιτσικώστες): στόχος = οι μέρες του μοτίβου
  // (ο Λεωνίδας 7/7 ΧΩΡΙΣ ρεπό — απόφαση 11/07/2026)
  const wp = rule(plan.agent, 'weekly_pattern');
  if (wp) return Math.max(0, Object.keys(wp.days).length - plan.leaveDays);
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
      return true;
    }
  }
  // Καμία επόμενη μέσα στην εβδομάδα: αν η ΕΠΟΜΕΝΗ εβδομάδα είναι εισηγμένη
  // (γνωστό πρόγραμμα), έλεγξε την πρώτη βάρδιά του εκεί (Κ8 σύνορο εμπρός)
  if (w.nextFirstStart) {
    const nfs = w.nextFirstStart.get(plan.agent.id);
    if (nfs != null && nfs - endAbs < rest) return false;
  }
  return true;
}

// Κ10: αν δουλέψει τη μέρα d, η συνεχόμενη σειρά (με σύνορα εβδομάδων) ≤ 5
function k10ok(w, plan, d) {
  // Εξαίρεση 6ημέρου (Τσιτσικώστες — απόφαση 11/07/2026)
  if (rule(plan.agent, 'no_streak_limit')) return true;
  const st = agentState(w, plan.agent.id);
  // Πίσω — η άδεια/ασθένεια ΣΥΝΕΧΙΖΕΙ τη σειρά (μόνο το ρεπό την κόβει)
  let back = 0;
  for (let i = d - 1; i >= 0; i--) {
    if (countsAsWork(plan, i)) back++;
    else break;
  }
  // Αν η σειρά φτάνει στη Δευτέρα, μετράει και το streak της προηγούμενης εβδομάδας
  if (back === d) back += st.streak;
  // Μπροστά — αν η σειρά φτάνει ως την Κυριακή, μετράει και η άδεια που
  // ξεκινά την επόμενη Δευτέρα (η άδεια είναι εργάσιμη — 13/07/2026)
  let fwd = 0;
  let i = d + 1;
  for (; i < 7; i++) {
    if (countsAsWork(plan, i)) fwd++;
    else break;
  }
  if (i === 7) fwd += leadingLeaveNextWeek(w, plan.agent.id);
  return back + 1 + fwd <= MAX_STREAK;
}

// Πόσες συνεχόμενες «εργάσιμες» μέρες ξεκινούν την ΕΠΟΜΕΝΗ Δευτέρα —
// άδεια/ασθένεια (μετράνε ως εργάσιμες, 13/07/2026) και, όταν η επόμενη
// εβδομάδα είναι ΕΙΣΗΓΜΕΝΗ από Excel (γνωστό πρόγραμμα), και οι βάρδιές της.
// Έτσι το 6ήμερο ελέγχεται ΚΑΙ προς τα εμπρός στο σύνορο.
function leadingLeaveNextWeek(w, agentId) {
  // Η επόμενη εβδομάδα είναι γνωστή (εισηγμένη): προϋπολογισμένο στο generatePeriod
  if (w.nextLead) return w.nextLead.get(agentId) || 0;
  let n = 0;
  for (let j = 7; j < 14; j++) {
    const t = w.ctx.timeOff.get(`${agentId}|${addDays(w.weekStart, j)}`);
    if (t === 'leave' || t === 'sick') n++;
    else break;
  }
  return n;
}

// Κ10 για την επιλογή ρεπό: με δεδομένα offs (σύνολο indexes) και υπόθεση
// εργασίας σε όλες τις άλλες μέρες, η μέγιστη σειρά ≤ 5 — μαζί με τυχόν
// άδεια που ξεκινά αμέσως μετά την Κυριακή (trailingLeave).
function offsKeepStreakOk(offs, initialStreak, trailingLeave = 0) {
  let run = initialStreak;
  for (let d = 0; d < 7; d++) {
    if (offs.has(d)) {
      run = 0;
    } else {
      run++;
      if (run > MAX_STREAK) return false;
    }
  }
  return run + trailingLeave <= MAX_STREAK;
}

// ---------- Έλεγχος κανόνων agent για συγκεκριμένη βάρδια ----------
// Ανεξάρτητο από την εβδομάδα — χρησιμοποιείται και από τον validator
// των χειροκίνητων αλλαγών (ΒΗΜΑ 5).
// opts: { override1903: bool (Κ9 υπερισχύει ατομικών ωραρίων), telework: bool }
function shiftAllowedByRules(agent, d, start, end, opts = {}) {
  const dow = d + 1; // 1=Δευτέρα ... 7=Κυριακή
  const isWknd = dow >= 6;
  const s = toMin(start);
  const e = toMin(end) <= s ? toMin(end) + 1440 : toMin(end);

  // 06:00-14:00 με περιορισμό ημερών (Νικολιάδης Δευ/Παρ, Αλίκη Τρι/Παρ):
  // στις μέρες του κανόνα και τα ΣΚ («μόνο αν βγαίνει») επιτρέπεται και
  // υπερισχύει των λοιπών ελέγχων ωραρίου· τις άλλες μέρες απαγορεύεται.
  const std = rule(agent, 'six_two_days');
  if (std && start === '06:00' && end === '14:00') {
    return std.days.includes(dow) || isWknd;
  }

  // Καλοκαιρινό weekly_pattern: στις μέρες του μοτίβου ΜΟΝΟ το ωράριο του
  // μοτίβου (υπερισχύει άλλων κανόνων ωραρίου)· τις υπόλοιπες μέρες ο
  // generator δίνει ρεπό — χειροκίνητη αλλαγή επιτρέπεται («ιδανικά» ρεπό).
  const wp = rule(agent, 'weekly_pattern');
  if (wp && (!wp.from || !opts.date || opts.date >= wp.from)) {
    const sh = wp.days[String(dow)];
    if (sh) return start === sh[0] && end === sh[1];
  }

  // Σταθερό ωράριο ΧΩΡΙΣ σταθερές μέρες (π.χ. Σταθοπούλου 16:00-24:00):
  // δουλεύει ΜΟΝΟ το ωράριό της, όποια μέρα κι αν μπει (Κ5 — 15/07/2026)
  if (agent.fixedStart && !agent.fixedDays && !opts.override1903) {
    return start === agent.fixedStart && end === agent.fixedEnd;
  }

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

// Μπορεί ο agent να δουλέψει ΚΑΘΟΛΟΥ τη μέρα d με την ΤΡΕΧΟΥΣΑ εικόνα του
// πλάνου; (κανόνες + Κ8 γειτονικών βαρδιών/συνόρου + Κ10 με άδειες).
// Χρησιμοποιείται για να πέφτουν τα ρεπό σε «νεκρές» μέρες και για τη
// σωστή προτεραιότητα στις λιγοστές θέσεις ΣΚ (HARD 2 ρεπό — 15/07/2026).
const PROBE_SHIFTS = [['08:00', '16:00'], ['09:00', '17:00'], ['07:30', '15:30'], ['10:00', '18:00'], ['16:00', '24:00'], ['15:30', '23:30'], ['14:00', '22:00'], ['06:00', '14:00']];
function agentDayWorkable(w, a, d) {
  const plan = w.plans.get(a.id);
  for (const [s, e] of PROBE_SHIFTS) {
    if (shiftAllowedByRules(a, d, s, e, { date: w.dates[d] }) &&
        k8ok(w, plan, d, s, e) &&
        k10ok(w, plan, d)) {
      return true;
    }
  }
  return false;
}

// Θα «σκοτώσει» η τοποθέτηση (s,e) στη μέρα d κάποια ΓΕΙΤΟΝΙΚΗ κενή
// καθημερινή του agent; Π.χ. 19:00-03:00 Τετάρτη + πρωινό Παρασκευής
// αφήνουν την Πέμπτη χωρίς κανένα νόμιμο ωράριο (Κ8 από τις δύο μεριές) →
// η μέρα χαραμίζεται σε αναγκαστικό 3ο ρεπό (HARD 2 ρεπό — 15/07/2026)
function killsAdjacentDay(w, plan, d, s, e) {
  for (const i of [d - 1, d + 1]) {
    if (i < 0 || i > 4) continue; // τα ΣΚ δεν γεμίζουν με fillers έτσι κι αλλιώς
    if (plan.days[i]) continue;
    if (!agentDayWorkable(w, plan.agent, i)) continue; // ήδη νεκρή — αδιάφορο
    plan.days[d] = { type: 'work', start: s, end: e, location: 'office' };
    const stillOk = agentDayWorkable(w, plan.agent, i);
    plan.days[d] = null;
    if (!stillOk) return true;
  }
  return false;
}

// Πλήρης έλεγχος τοποθέτησης
function canPlace(w, plan, d, start, end, opts = {}) {
  if (plan.days[d]) return false; // Κ2: 1 βάρδια/μέρα, όχι πάνω σε ρεπό/άδεια
  if (!opts.ignoreTarget && assignedCount(plan) >= workTarget(plan)) return false; // Κ2: 5 εργάσιμες

  // Λίστα 06:00-14:00: τη βάρδια την παίρνουν ΜΟΝΟ οι εγκεκριμένοι (11/07/2026)
  if (start === '06:00' && end === '14:00') {
    const list = w.ctx.eligibility.get('06:00-14:00');
    if (list && list.size > 0 && !list.has(plan.agent.id)) return false;
  }

  // Όριο Κυριακών/μήνα: έως 2 για μη-σταθερούς εκτός supervisors.
  // Ο Νικολιάδης (sunday_worker) ΔΟΥΛΕΥΕΙ Κυριακές χωρίς όριο —
  // αντίθετα, περιορίζονται τα ΡΕΠΟ Κυριακής του (το πολύ 1/μήνα, βλ. phaseOffs)
  // Εξαίρεση (απόφαση 15/07/2026): το «ακριβώς 2 ρεπό» υπερισχύει του ορίου
  // Κυριακών. Όταν ο agent θα έπαιρνε αλλιώς 3ο ρεπό (opts.allowSundayOver
  // από το win-win πέρασμα), επιτρέπεται 3η Κυριακή για να πιάσει 5 μέρες.
  if (d === 6 && !opts.allowSundayOver && !sundayExempt(plan.agent) && !rule(plan.agent, 'sunday_worker')) {
    const st = agentState(w, plan.agent.id);
    const used = (st.sundays && st.sundays[w.dates[6].slice(0, 7)]) || 0;
    if (used >= 2) return false;
  }

  if (!shiftAllowedByRules(plan.agent, d, start, end, { ...opts, date: w.dates[d] })) return false;
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
  // Το ΗΡΩΝ δεν λειτουργεί Σαββατοκύριακα (12/07/2026) — πράσινο ΜΟΝΟ Δευ-Παρ
  if (rule(agent, 'heron_weekdays') && dow <= 5) return get('Ήρων');
  if (agent.skills.has('ΗΡΩΝ') && !agent.skills.has('EUROBANK') && dow <= 5) return get('Ήρων');
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

    // Οφειλόμενη ανάπαυση από νυχτερινές στο ΤΕΛΟΣ της προηγούμενης εβδομάδας
    // (π.χ. βράδυ Κυριακή → ρεπό Δευτέρα· 2 βράδια Σαβ+Κυρ → ρεπό Δευ+Τρι)
    const st0 = agentState(w, a.id);
    for (let i = 0; i < (st0.pendingNightRest || 0) && i < 7; i++) {
      if (!plan.days[i]) {
        markOff(w, plan, i, 'night_rest');
        plan.offNeeded = Math.max(0, plan.offNeeded - 1);
      }
    }

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

    // Σταθερά ωράρια σε σταθερές μέρες (Κ5) — με σεβασμό στο Κ10: αν η
    // τοποθέτηση θα έφτιαχνε 6ήμερο (π.χ. μαζί με επερχόμενη ΑΔΕΙΑ που
    // μετράει ως εργάσιμη), παραλείπεται με σημείωση
    if (a.fixedStart && a.fixedDays) {
      for (const dow of a.fixedDays) {
        const d = dow - 1;
        if (plan.days[d]) continue; // άδεια/ρεπό υπερισχύει (Κ6)
        if (assignedCount(plan) >= workTarget(plan)) break;
        if (!k10ok(w, plan, d)) {
          w.report.soft.push(`${a.name}: σταθερή βάρδια ${w.dates[d]} παραλείφθηκε — θα έσπαγε το 6ήμερο (Κ10, η άδεια μετρά ως εργάσιμη).`);
          continue;
        }
        const c = fillerColor(ctx, a, d, a.fixedStart, a.fixedEnd);
        place(w, plan, d, {
          start: a.fixedStart, end: a.fixedEnd,
          label: a.workLocation === 'home' ? 'ΤΗΛΕΡΓΑΣΙΑ' : null,
          location: a.workLocation, fixed: true, ...c
        });
      }
    }

    // Σπαστό ωράριο Κουλογιάννη: 09:00-24:00 με parts (μία «βάρδια» τη μέρα)
    // — με σεβασμό στο Κ10 και στο σύνορο με εισηγμένο πρόγραμμα
    const sp = rule(a, 'split_shift');
    if (sp) {
      for (const dow of sp.days) {
        const d = dow - 1;
        if (plan.days[d]) continue;
        if (assignedCount(plan) >= workTarget(plan)) break;
        if (!k10ok(w, plan, d)) {
          w.report.soft.push(`${a.name}: σπαστό ${w.dates[d]} παραλείφθηκε — θα έσπαγε το 6ήμερο (Κ10).`);
          continue;
        }
        const c = fillerColor(ctx, a, d, sp.parts[0][0], sp.parts[1][1]);
        place(w, plan, d, {
          start: sp.parts[0][0], end: sp.parts[1][1],
          parts: sp.parts, label: 'ΣΠΑΣΤΟ', location: a.workLocation, fixed: true, ...c
        });
      }
    }

    // Βάρδια ΣΚ Αγγελούδη (16:00-24:00) — Κ5, με σεβασμό στο Κ10 (η άδεια
    // της επόμενης εβδομάδας μετράει ως εργάσιμη)
    if (a.weekendShift) {
      const [ws, we] = a.weekendShift.split('-');
      for (const d of [5, 6]) {
        if (plan.days[d]) continue;
        if (assignedCount(plan) >= workTarget(plan)) break;
        if (!k10ok(w, plan, d)) {
          w.report.soft.push(`${a.name}: βάρδια ΣΚ ${w.dates[d]} παραλείφθηκε — θα έσπαγε το 6ήμερο (Κ10, η άδεια μετρά ως εργάσιμη).`);
          continue;
        }
        const c = fillerColor(ctx, a, d, ws, we);
        place(w, plan, d, { start: ws, end: we, location: a.workLocation, fixed: true, ...c });
      }
    }

    // Καλοκαιρινό weekly_pattern (Τσιτσικώστες — 11/07/2026): τοποθέτηση
    // του μοτίβου στις μέρες του· οι υπόλοιπες μέρες γίνονται ρεπό
    // (ο Λεωνίδας δεν έχει καμία — δουλεύει 7/7)
    const wp = rule(a, 'weekly_pattern');
    if (wp) {
      for (let d = 0; d < 7; d++) {
        if (plan.days[d]) continue; // άδεια/ρεπό υπερισχύει (Κ6)
        if (wp.from && w.dates[d] < wp.from) continue;
        const sh = wp.days[String(d + 1)];
        if (sh) {
          const c = fillerColor(ctx, a, d, sh[0], sh[1]);
          place(w, plan, d, { start: sh[0], end: sh[1], location: a.workLocation, fixed: true, ...c });
        } else {
          markOff(w, plan, d, 'fixed_off');
        }
      }
      plan.offNeeded = 0;
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

  // Δευτέρες: προτιμάται ο Νικολιάδης στο 06:00-14:00, όχι όμως κάθε
  // Δευτέρα (13/07/2026) — τηλεργασία σε ΕΝΑΛΛΑΞ εβδομάδες
  for (const a of pair) {
    const r = rule(a, 'day_off_or_telework');
    if (!r.days.includes(1) || r.days.includes(2)) continue; // μόνο όποιος έχει μέρα κανόνα τη Δευτέρα
    const evenWeek = Math.floor(dayNum(w.weekStart) / 7) % 2 === 0;
    const plan = w.plans.get(a.id);
    if (evenWeek && canPlace(w, plan, 0, r.shift[0], r.shift[1], { telework: true })) {
      const pir = ctx.roles.get('Πειραιώς') || { id: null, color: null };
      place(w, plan, 0, {
        start: r.shift[0], end: r.shift[1],
        skill: 'ΠΕΙΡΑΙΩΣ', label: 'ΤΗΛΕΡΓΑΣΙΑ', location: 'home',
        roleName: 'Πειραιώς', roleId: pir.id, color: pir.color
      });
    }
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

// Φάση 3: Νυχτερινές 23:00/23:30 (Κ4, Κ7) — κανόνες 14/07/2026:
//   * κάθε agent έως 2 βράδια/εβδομάδα
//   * μετά το βράδυ ΥΠΟΧΡΕΩΤΙΚΑ ρεπό (2 σερί βράδια → 2 σερί ρεπό)
//   * η οφειλόμενη ανάπαυση που «ξεφεύγει» από την εβδομάδα μεταφέρεται
//     στην επόμενη (pendingNightRest)
function phaseNights(w, nightReqByDay) {
  const { ctx } = w;
  const pool = ctx.agents.filter((a) => a.canNight && a.skills.has('EUROBANK'));
  const euro = ctx.roles.get('Eurobank') || { id: null, color: null };
  const nightsIn = (plan) => plan.days.filter((e) => e && e.type === 'work' && e.night).length;

  // Ευθυγράμμιση με ΑΙΤΗΜΑΤΑ ΡΕΠΟ (14/07/2026): η υποχρεωτική ανάπαυση μετά
  // τα βράδια πρέπει να ΠΕΦΤΕΙ ΠΑΝΩ στο ζητημένο ρεπό — π.χ. αίτημα Παρασκευή
  // → βράδια Τρίτη+Τετάρτη → ρεπό Πέμπτη+Παρασκευή = σύνολο 2 ρεπό, όχι 3.
  // Αλλιώς, τα βράδια πάνε σε κάποιον χωρίς αίτημα.
  function requestAlignment(a, d) {
    const plan = w.plans.get(a.id);
    const reqDays = [];
    for (let i = 0; i < 7; i++) {
      const e = plan.days[i];
      if (e && e.type === 'off' && e.reason === 'repo_request') reqDays.push(i);
    }
    if (reqDays.length === 0) return 0; // χωρίς αίτημα — ουδέτερο
    const closingPair = d > 0 && plan.days[d - 1] && plan.days[d - 1].night;
    // Πιθανές μέρες ανάπαυσης: ζευγάρι που κλείνει τώρα → d+1,d+2·
    // πρώτο βράδυ → d+1 (μονό) ή d+2,d+3 (αν γίνει ζευγάρι αύριο)
    const restCandidates = closingPair ? [d + 1, d + 2] : [d + 1, d + 2, d + 3];
    return reqDays.some((r) => restCandidates.includes(r)) ? 25 : -30;
  }

  for (let d = 0; d < 7; d++) {
    if (!nightReqByDay[d]) continue;
    const cands = pool
      .filter((a) => {
        const plan = w.plans.get(a.id);
        const n = nightsIn(plan);
        if (n >= 2) return false; // έως 2 βράδια/εβδομάδα
        // Το 2ο βράδυ ΜΟΝΟ ΣΥΝΕΧΟΜΕΝΟ με το 1ο (π.χ. Δευ+Τρι) — 14/07/2026
        const prevNight = d > 0 && plan.days[d - 1] && plan.days[d - 1].night;
        if (n === 1 && !prevNight) return false;
        // Η ανάπαυση μετά το βράδυ πρέπει να χωράει: η επόμενη μέρα (αν είναι
        // μέσα στην εβδομάδα) να μην έχει ήδη βάρδια
        if (d + 1 < 7 && plan.days[d + 1] && plan.days[d + 1].type === 'work') return false;
        return canPlace(w, plan, d, '23:30', '07:30');
      })
      .sort((x, y) => {
        // Προτίμησε να «κλείσει» ζευγάρι με τον χθεσινό νυχτερινό — αλλιώς
        // η λίστα εξαντλείται σε σκόρπια μονά και μένουν μέρες ακάλυπτες
        const pairX = d > 0 && w.plans.get(x.id).days[d - 1] && w.plans.get(x.id).days[d - 1].night ? 0 : 1;
        const pairY = d > 0 && w.plans.get(y.id).days[d - 1] && w.plans.get(y.id).days[d - 1].night ? 0 : 1;
        if (pairX !== pairY) return pairX - pairY;
        // Ευθυγράμμιση ανάπαυσης με αιτήματα ρεπό (μεγαλύτερο = καλύτερο)
        const alX = requestAlignment(x, d);
        const alY = requestAlignment(y, d);
        if (alX !== alY) return alY - alX;
        const lrX = rule(x, 'night_last_resort') ? 1 : 0;
        const lrY = rule(y, 'night_last_resort') ? 1 : 0;
        if (lrX !== lrY) return lrX - lrY;
        // Όποιος έχει ήδη «χρεωθεί» τη μισή εβδομάδα σε βράδια/ανάπαυση
        // (π.χ. night_rest που κουβαλήθηκε από την προηγούμενη) πάει τελευταίος
        // — αλλιώς κολλάει σε αέναο κύκλο 2 βράδια + 2 ρεπό = 2 εργάσιμες
        const costX = w.plans.get(x.id).days.filter((e) => e && ((e.type === 'work' && e.night) || (e.type === 'off' && e.reason === 'night_rest'))).length;
        const costY = w.plans.get(y.id).days.filter((e) => e && ((e.type === 'work' && e.night) || (e.type === 'off' && e.reason === 'night_rest'))).length;
        if (costX !== costY) return costX - costY;
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

  // Υποχρεωτική ανάπαυση μετά από κάθε «σειρά» βραδιών: όσα βράδια, τόσα
  // συνεχόμενα ρεπό αμέσως μετά — ό,τι δεν χωράει στην εβδομάδα οφείλεται
  // στην επόμενη (pendingNightRest)
  for (const a of pool) {
    const plan = w.plans.get(a.id);
    plan.pendingNightRest = 0;
    let d = 0;
    while (d < 7) {
      const e = plan.days[d];
      if (e && e.type === 'work' && e.night) {
        let len = 1;
        while (d + len < 7 && plan.days[d + len] && plan.days[d + len].type === 'work' && plan.days[d + len].night) len++;
        let owed = len;
        let i = d + len;
        while (owed > 0 && i < 7) {
          if (!plan.days[i]) {
            markOff(w, plan, i, 'night_rest');
            plan.offNeeded = Math.max(0, plan.offNeeded - 1);
          }
          // Μέρα ήδη ρεπό/άδεια: μετράει ως ανάπαυση
          owed--;
          i++;
        }
        plan.pendingNightRest = owed; // μεταφέρεται στην επόμενη εβδομάδα
        d = i;
      } else {
        d++;
      }
    }
  }
}

// Φάση 4: κατανομή ρεπό (Σ2 συνεχόμενα, Σ3 εξισορρόπηση ΣΚ, Κ10 στα σύνορα).
// Κρίσιμο: τα ρεπό πρέπει να μοιράζονται ώστε ΚΑΘΕ μέρα (ιδίως τα ΣΚ) να
// μένουν αρκετοί διαθέσιμοι επιλέξιμοι για κάθε απαίτηση κάλυψης.
function phaseOffs(w, reqByDay) {
  const { ctx } = w;

  // Υπάρχει ακόμα ανοιχτό 19:00-03:00 slot τη μέρα d που μπορεί να πάρει ο
  // agent στο pass B; (τότε ΜΗΝ του κλειδώσεις τη μέρα ως ρεπό)
  const open1903 = (a, d) => {
    if (!reqByDay) return false;
    const list = ctx.eligibility.get('19:00-03:00');
    if (list && list.size > 0 && !list.has(a.id)) return false;
    for (const rq of reqByDay[d]) {
      if (rq.def.start === '19:00' && rq.covered < rq.def.headcount) return true;
    }
    return false;
  };

  const eligibleFor = (agent, r, d) => {
    if (!deptMatch(agent, r.department)) return false;
    if (r.skill && !agent.skills.has(r.skill)) return false;
    // Βάρδιες με λίστα επιλεξιμότητας (06:00-14:00, 19:00-03:00): μόνο τα
    // μέλη της μετράνε ως διαθέσιμο pool — αλλιώς τα ρεπό «καίνε» τη λίστα
    const list = ctx.eligibility.get(`${r.start}-${r.end}`);
    if (list && list.size > 0 && !list.has(agent.id)) return false;
    // Οι ατομικοί κανόνες ωραρίου μετράνε: π.χ. οι «μόνο πρωί» ΔΕΝ είναι
    // διαθέσιμο pool για το απογευματινό Πειραιώς (13/07/2026)
    if (!shiftAllowedByRules(agent, d, r.start, r.end, { date: w.dates[d] })) return false;
    return true;
  };

  // Πόσο θα «πονέσει» η μέρα d αν πάρει ρεπό ο agent: αν οι εναπομείναντες
  // διαθέσιμοι επιλέξιμοι πέσουν κοντά/κάτω από το headcount μιας απαίτησης,
  // τεράστια ποινή. Υπολογίζεται ΔΥΝΑΜΙΚΑ πάνω στο τρέχον πλάνο.
  function dayRisk(agent, d) {
    const dow = d + 1;
    const reqs = ctx.requirements[dow >= 6 ? 'weekend' : 'weekday'];
    // Ομαδοποίηση απαιτήσεων με το ΙΔΙΟ pool (τμήμα+skill): η ζήτηση
    // ΑΘΡΟΙΖΕΤΑΙ — π.χ. 2 slots supervisors/μέρα σημαίνει ότι με 2
    // διαθέσιμους supervisors ΚΑΝΕΙΣ τους δεν παίρνει ρεπό (14/07/2026)
    const groups = new Map(); // key → {demand, avail}
    for (const r of reqs) {
      if (!eligibleFor(agent, r, d)) continue;
      const key = `${r.department || ''}|${r.skill || ''}`;
      if (!groups.has(key)) {
        let avail = 0;
        for (const x of ctx.agents) {
          if (!eligibleFor(x, r, d)) continue;
          const e = w.plans.get(x.id).days[d];
          if (!e || e.type === 'work') avail++;
        }
        groups.set(key, { demand: 0, avail });
      }
      groups.get(key).demand += r.headcount;
    }
    let risk = 0;
    for (const g of groups.values()) {
      const after = g.avail - 1;
      if (after < g.demand) risk += 200; // θα μείνει ακάλυπτο σχεδόν σίγουρα
      else if (after < g.demand + 2) risk += 80; // οριακό — απόφυγέ το έντονα
      else risk += 6 / after;
    }
    return risk;
  }

  // Πόσα ρεπό έχουν ήδη δοθεί τη μέρα d (εξισορρόπηση φόρτου ημέρας —
  // ΜΟΝΟ για καθημερινές: με το hard ΣΚ MAX τα ρεπό ΠΡΕΠΕΙ να μαζεύονται ΣΚ)
  function offLoad(d) {
    if (d >= 5) return 0;
    let n = 0;
    for (const a of ctx.agents) {
      const e = w.plans.get(a.id).days[d];
      if (e && e.type === 'off') n++;
    }
    return n;
  }

  const dayWorkable = (a, d) => agentDayWorkable(w, a, d);

  // Λιγότερο ευέλικτοι πρώτοι: λίγες ελεύθερες μέρες, και μετά ΜΕΓΑΛΟ
  // εισερχόμενο streak (το 5άρι σερί ΑΝΑΓΚΑΖΕΙ ρεπό Δευτέρα — πρέπει να
  // το δουν πρώτοι ώστε οι υπόλοιποι να αποφύγουν την ίδια μέρα)
  const order = [...ctx.agents].sort((x, y) => {
    const fx = w.plans.get(x.id).days.filter((e) => !e).length;
    const fy = w.plans.get(y.id).days.filter((e) => !e).length;
    if (fx !== fy) return fx - fy;
    return (agentState(w, y.id).streak || 0) - (agentState(w, x.id).streak || 0);
  });

  for (const a of order) {
    const plan = w.plans.get(a.id);

    // ΣΚ MAX (hard): οι θέσεις ΣΚ μοιράστηκαν ΗΔΗ (phaseRequirements [5,6])
    // και οι fillers δεν αγγίζουν ΣΚ — άρα κάθε κενό Σάββατο/Κυριακή είναι
    // ΑΝΑΠΟΦΕΥΚΤΟ ρεπό. Αν ΚΑΙ ΤΑ ΔΥΟ ΣΚ είναι ελεύθερα (δεν πήρε θέση),
    // γίνονται ΜΑΖΙ το ζευγάρι ρεπό του (Σαβ+Κυρ συνεχόμενα) — αλλιώς θα
    // κατέληγε με ρεπό καθημερινής + έξτρα ΣΚ = 3+ ρεπό (HARD 2 ρεπό).
    // ΟΜΩΣ αν δουλεύει ΤΟ ΕΝΑ ΣΚ (π.χ. Κυριακή), ΜΗΝ κλειδώνεις το ελεύθερο
    // Σάββατο εδώ μεμονωμένα: ο βρόχος παρακάτω θα το ζευγαρώσει με την
    // Παρασκευή (Παρ+Σαβ συνεχόμενα) — τα ρεπό ΜΑΖΙ (προτίμηση 15/07/2026).
    for (const d of [5, 6]) {
      if (plan.offNeeded <= 0) break;
      if (plan.days[d]) continue;
      if (open1903(a, d)) continue; // ίσως πάρει 19:00-03:00 στο pass B
      markOff(w, plan, d, 'repo');
      plan.offNeeded--;
    }

    // Μετά, ΝΤΕΤΕΡΜΙΝΙΣΤΙΚΑ: μέρες που ο agent ΔΕΝ μπορεί να δουλέψει
    // (κανόνες/Κ8 από το σύνορο, π.χ. Δευτέρα πρωί μετά από Κυριακή 24:00
    // για «μόνο πρωί») γίνονται τα ρεπό του — αλλιώς χαραμίζονται και
    // καταλήγει με 3ο ρεπό (HARD 2 ρεπό — 15/07/2026)
    for (let d = 0; d < 7 && plan.offNeeded > 0; d++) {
      if (plan.days[d]) continue;
      if (!dayWorkable(a, d)) {
        markOff(w, plan, d, 'repo');
        plan.offNeeded--;
      }
    }

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
        // Η άδεια/ασθένεια ΔΕΝ μπαίνει στα «ρεπό» — μετράει ως εργάσιμη
        // για τη σειρά συνεχόμενων ημερών (13/07/2026)
        for (let d = 0; d < 7; d++) {
          const e = plan.days[d];
          if (e && e.type === 'off' && e.reason !== 'leave' && e.reason !== 'sick') offs.add(d);
        }
        if (opt.some((d) => plan.days[d])) continue;
        if (!rule(a, 'no_streak_limit') && !offsKeepStreakOk(offs, st.streak, leadingLeaveNextWeek(w, a.id))) continue;

        // Νικολιάδης (sunday_worker): το πολύ 1 ρεπό Κυριακής τον μήνα (hard)
        if (opt.includes(6) && rule(a, 'sunday_worker')) {
          const mk = w.dates[6].slice(0, 7);
          if (((st.sundaysOff || {})[mk] || 0) >= 1) continue;
        }

        let score = 0;
        // Σ2 ΔΥΝΑΤΑ (15/07/2026): τα ρεπό ΜΑΖΙ για όλους — όχι σπαστά.
        // Το bonus πρέπει να νικά το «οριακό» dayRisk (~80) της ενδιάμεσης
        // μέρας ώστε να προτιμηθεί το ΣΥΝΕΧΟΜΕΝΟ ζευγάρι — αλλά ΟΧΙ το κρίσιμο
        // (200, θα έμενε ακάλυπτο). Έτσι οι εργαζόμενοι ΣΚ παίρνουν Δευ+Τρι
        // μαζί αντί για σπαστά. (προτίμηση συνεχόμενων ρεπό — 15/07/2026)
        if (opt.length === 2) score += rule(a, 'consecutive_off_strong') ? 90 : 55;
        // Μονό ρεπό: προτίμησε να «κολλήσει» δίπλα σε υπάρχον ρεπό/αίτημα
        // (π.χ. αίτημα Τετάρτη → το δεύτερο ρεπό Τρίτη ή Πέμπτη)
        if (opt.length === 1) {
          const d0 = opt[0];
          const adj = [d0 - 1, d0 + 1].some((i) => {
            if (i < 0 || i > 6) return false;
            const e = plan.days[i];
            return e && e.type === 'off';
          });
          if (adj) score += 35;
        }
        // Σ3: όποιος έχει δουλέψει πολλά ΣΚ, να ξεκουράζεται ΣΚ
        const wkndDays = opt.filter((d) => d >= 5).length;
        score += wkndDays * Math.min(st.weekends, 6) * 2;
        // Τα ΣΚ έχουν ΜΟΝΟ τις απαιτήσεις του πίνακα (MAX hard — 14/07/2026):
        // οι θέσεις ΣΚ είναι λίγες, άρα τα παραγόμενα ρεπό πάνε ΣΚ σχεδόν
        // πάντα — αλλιώς μένουν κενές ΣΚ μέρες και σπάει το «ακριβώς 2 ρεπό»
        score += wkndDays * 12;
        // Supervisors: τα ρεπό τους κατά προτίμηση ΣΚ — τις καθημερινές
        // χρειάζονται και οι 2 βάρδιες τους (14/07/2026)
        if (a.departments.includes('supervisor')) score += wkndDays * 10;
        // sunday_worker: απόφυγε γενικά τα ρεπό Κυριακής — δουλεύει Κυριακές
        if (opt.includes(6) && rule(a, 'sunday_worker')) score -= 25;
        for (const d of opt) {
          score -= dayRisk(a, d); // μη «κάψεις» σπάνιο πόρο
          score -= offLoad(d) * 2; // ισοκατανομή ρεπό στις καθημερινές
          // Μέρα που ΔΕΝ μπορεί να δουλέψει (κανόνες/Κ8 συνόρου) = ιδανικό ρεπό
          if (!dayWorkable(a, d)) score += 30;
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
function phaseRequirements(w, reqByDay, opts = {}) {
  const { ctx } = w;

  // Ταιριάζει μια υπάρχουσα ανάθεση με την απαίτηση; (ακριβές ωράριο,
  // period πρωί/απόγευμα, ή η ειδική περίπτωση ΣΚ Αγγελούδη)
  function entryMatches(e, def, d) {
    if (e.start === def.start && e.end === def.end) return true;
    if (def.period === 'morning' && isMorning(e.start, e.end)) return true;
    if (def.period === 'afternoon' && isAfternoon(e.start)) return true;
    return false;
  }

  for (const d of (opts.days || [0, 1, 2, 3, 4, 5, 6])) {
    for (const rq of reqByDay[d]) {
      if (rq.def.start === '23:00') continue; // νυχτερινή: καλύφθηκε στη φάση 3
      if (rq.def.start === '19:00') continue; // 19:00-03:00: φάση 6 (Κ9)

      // 1) Μετρά ήδη τοποθετημένες βάρδιες που ταιριάζουν (σταθερά ωράρια Κ5,
      //    ΣΚ Αγγελούδη, period-based Πειραιώς/ΗΡΩΝ/Verification κ.λπ.)
      for (const a of ctx.agents) {
        if (rq.covered >= rq.def.headcount) break;
        const plan = w.plans.get(a.id);
        const e = plan.days[d];
        if (!e || e.type !== 'work' || e.usedForReq || e.night) continue;
        if (!deptMatch(a, rq.def.department)) continue;
        if (rq.def.skill && !a.skills.has(rq.def.skill)) continue;
        if (entryMatches(e, rq.def, d)) {
          e.usedForReq = true;
          e.reqLabel = rq.def.label;
          if (!e.color && rq.def.color) { e.color = rq.def.color; e.roleId = rq.def.roleId; }
          rq.covered++;
        }
      }

      // Υποψήφια ωράρια: για period-απαιτήσεις δοκιμάζονται εναλλακτικές
      // ώστε να χωρούν και agents με περιορισμούς ωραρίου
      const shiftOptions = rq.def.period
        ? (rq.def.period === 'morning'
            ? [[rq.def.start, rq.def.end], ...FILLER_MORNING.filter(([s]) => s !== rq.def.start)]
            : [[rq.def.start, rq.def.end], ...FILLER_AFTERNOON.filter(([s]) => s !== rq.def.start)])
        : [[rq.def.start, rq.def.end]];

      // 2) Νέες τοποθετήσεις για ό,τι λείπει
      while (rq.covered < rq.def.headcount) {
        const cands = [];
        for (const a of ctx.agents) {
          if (!deptMatch(a, rq.def.department)) continue;
          if (rq.def.skill && !a.skills.has(rq.def.skill)) continue;
          const plan = w.plans.get(a.id);
          const telework = a.workLocation === 'home';

          // Πρώτο ωράριο που επιτρέπεται για τον agent
          let shift = null;
          for (const [s, e] of shiftOptions) {
            if (canPlace(w, plan, d, s, e, { telework })) { shift = [s, e]; break; }
          }
          if (!shift) continue;
          const [shS, shE] = shift;

          // Scoring
          let score = 100;
          const st = agentState(w, a.id);
          // Σ4 ΔΥΝΑΤΟ: συνέπεια ημι-ημέρας μέσα στην εβδομάδα. Το ανακάτεμα
          // πρωί/απόγευμα δημιουργεί «παγιδευμένες» ενδιάμεσες μέρες — 11h
          // ανάπαυση αδύνατη μεταξύ απογεύματος (λήξη 23:30) και επόμενου
          // πρωινού (08:00) — που καταλήγουν σε αναγκαστικό 3ο ρεπό (15/07/2026)
          const myMorning = isMorning(shS, shE);
          for (let i = 0; i < 7; i++) {
            const e = plan.days[i];
            if (!e || e.type !== 'work') continue;
            if (e.start === shS) score += 8;
            if (isMorning(e.start, e.end) === myMorning) score += 6;
            else score -= 30;
          }
          // Προτεραιότητα σε όσους απέχουν από τον στόχο 5 ημερών
          score += (workTarget(plan) - assignedCount(plan)) * 4;
          // Σ3: λιγότερα ΣΚ ιστορικά → προτεραιότητα το ΣΚ
          if (d >= 5) score -= Math.min(st.weekends, 10) * 2;
          // HARD 2 ρεπό (15/07/2026): όποιος έχει υποχρεωτικά ρεπό μέσα στην
          // εβδομάδα (μέρες σχολής, αναπαύσεις βραδιών, αιτήματα) ΧΡΕΙΑΖΕΤΑΙ
          // θέση ΣΚ για να φτάσει τις 5 εργάσιμες — παίρνει ισχυρή προτεραιότητα
          if (d >= 5) {
            // Ελεύθερες ΚΑΙ πραγματικά εργάσιμες καθημερινές (κανόνες/Κ8/Κ10 —
            // π.χ. Παρασκευή μπλοκαρισμένη από 6ήμερο-με-Κυριακή δεν μετράει)
            let wdFree = 0;
            for (let i = 0; i < 5; i++) {
              if (!plan.days[i] && agentDayWorkable(w, a, i)) wdFree++;
            }
            const needWknd = workTarget(plan) - assignedCount(plan) - wdFree;
            // Κυρίαρχο κριτήριο: χωρίς θέση ΣΚ αυτός βγαίνει ΜΑΘΗΜΑΤΙΚΑ με
            // 3ο ρεπό (οι καθημερινές δεν του φτάνουν για 5 εργάσιμες)
            if (needWknd > 0) score += needWknd * 60;
            // Όποιος ΔΕΝ χρειάζεται τη θέση ΣΚ (χωράει στις καθημερινές)
            // την αφήνει σε όποιον τη χρειάζεται — ΕΚΤΟΣ των supervisors:
            // οι δικές τους θέσεις ΣΚ καλύπτονται μόνο από αυτούς
            else if (!a.departments.includes('supervisor')) score -= 15;
            // Ρεπό ΜΑΖΙ (15/07/2026): όποιος δουλεύει Σάββατο πρέπει να δουλεύει
            // ΚΑΙ Κυριακή (ΣΥΖΕΥΞΗ) — αλλιώς μένει με ρεπό Κυριακής + καθημερινής
            // = σπαστά. Ισχυρό bonus ώστε να νικά το needWknd (που μειώνεται
            // μόλις πάρει το Σάββατο): οι ίδιοι κάνουν όλο το ΣΚ, οι υπόλοιποι
            // παίρνουν Σαβ+Κυρ μαζί. (προτίμηση συνεχόμενων ρεπό — 15/07/2026)
            if (d === 6) {
              const sat = plan.days[5];
              if (sat && sat.type === 'work') score += 30;
            }
          }
          // Μην αχρηστεύεις γειτονική κενή καθημερινή (νεκρή μέρα = 3ο ρεπό)
          if (killsAdjacentDay(w, plan, d, shS, shE)) score -= 45;
          // Νικολιάδης: δουλεύει Κυριακές — βολεύει (11/07/2026). Ισχυρό bonus:
          // με το «ΣΚ MAX» πρέπει να κερδίζει θέση Κυριακής, αλλιώς μένει
          // άθελά του με 2ο ρεπό Κυριακής τον μήνα
          if (d === 6 && rule(a, 'sunday_worker')) score += 40;
          // Προτιμήσεις πρωί/απόγευμα (soft)
          if (rule(a, 'prefer_morning')) score += isMorning(shS, shE) ? 5 : -6;
          if (rule(a, 'prefer_afternoon')) score += isAfternoon(shS) ? 5 : -6;
          // Διατήρηση ευελιξίας: όσοι μπορούν ΜΟΝΟ αυτό το είδος βάρδιας
          // προηγούνται, ώστε οι ευέλικτοι να μένουν για τις υπόλοιπες
          if (isMorning(shS, shE) && rule(a, 'only_morning')) score += 14;
          if (isAfternoon(shS) && (rule(a, 'only_afternoon') || rule(a, 'allowed_shifts'))) score += 14;
          // Eurobank μόνο σε απόλυτη ανάγκη (Δεληκωστοπούλου)
          if (rq.def.skill && rule(a, 'skill_last_resort') && rule(a, 'skill_last_resort').skill === rq.def.skill) score -= 60;
          // ΗΡΩΝ τις καθημερινές: μείνε στον ΗΡΩΝ — όχι σε ΑΛΛΕΣ απαιτήσεις
          if (rule(a, 'heron_weekdays') && d < 5 && rq.def.skill !== 'ΗΡΩΝ') score -= 30;
          // Μπακούλης: όταν απογευματινή διά ζώσης → 15:30-23:30 International
          const asi = rule(a, 'afternoon_shift_international');
          if (asi && isAfternoon(shS)) {
            score += shS === asi.shift[0] && rq.def.label === 'International' ? 15 : -15;
          }
          // Ρίζου: εναλλαγή πρωί/απόγευμα ανά εβδομάδα
          if (rule(a, 'weekly_alternation')) {
            const wantMorning = agentState(w, a.id).rizouMode === 'morning';
            if (isMorning(shS, shE) !== wantMorning) score -= 50;
          }
          // 06:00-14:00: δίκαιη εναλλαγή μεταξύ των ατόμων της λίστας
          // (12/07/2026) — όποιος το έχει κάνει λιγότερο, προηγείται.
          // Η Ρίζου («καμιά φορά ΣΚ») παίρνει επιπλέον ποινή ώστε να μπαίνει σπάνια.
          if (shS === '06:00' && shE === '14:00') {
            score -= (st.count62 || 0) * 6;
            const std62 = rule(a, 'six_two_days');
            if (std62 && std62.days.length === 2 && std62.days[0] === 6) score -= 20;
            // Δευτέρες: προτιμάται ο Νικολιάδης στο 06:00-14:00 — όχι όμως
            // κάθε Δευτέρα (13/07/2026): μέτριο bonus, η εναλλαγή ισορροπεί
            if (d === 0 && std62 && std62.days.includes(1)) score += 10;
          }

          cands.push({ a, score, shift });
        }

        if (cands.length === 0) {
          w.report.uncovered.push({
            date: w.dates[d],
            start: rq.def.start,
            end: rq.def.end,
            label: rq.def.label + (rq.def.period ? (rq.def.period === 'morning' ? ' (πρωί)' : ' (απόγευμα)') : ''),
            missing: rq.def.headcount - rq.covered
          });
          break;
        }
        cands.sort((x, y) => y.score - x.score || x.a.id - y.a.id);
        const { a, shift } = cands[0];
        const telework = a.workLocation === 'home';
        place(w, w.plans.get(a.id), d, {
          start: shift[0], end: shift[1],
          skill: rq.def.skill, reqLabel: rq.def.label, usedForReq: true,
          label: [telework ? 'ΤΗΛΕΡΓΑΣΙΑ' : null, rq.def.label === 'International' ? 'INTERNATIONAL' : null].filter(Boolean).join(' ') || null,
          location: telework ? 'home' : 'office',
          roleId: rq.def.roleId, color: rq.def.color
        });
        rq.covered++;
      }
    }
  }
}

// Φάση 6: βάρδια 19:00-03:00 (Κ9 — μόνο λίστα, όρια/εβδομάδα, Αγγελή όχι μόνη).
// Τρέχει σε ΔΥΟ περάσματα (14/07/2026): pass A ΠΡΙΝ τις υπόλοιπες απαιτήσεις
// (χωρίς τους «όχι μόνος» — κρατά θέση πριν φαγωθεί η λίστα από τα call
// slots), pass B μετά, όταν η παρουσία γραφείου είναι γνωστή για την Αγγελή.
function phase1903(w, reqByDay, opts = {}) {
  const { ctx } = w;
  const verif = ctx.roles.get('Verification') || { id: null, color: null };
  const is1903 = (e) => e && e.type === 'work' && e.start === '19:00' && e.end === '03:00';

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

  for (let d = 0; d < 7; d++) { // ΚΑΘΕ μέρα Δευ-Κυρ (14/07/2026)
    const rq = reqByDay[d].find((r) => r.def.start === '19:00');
    if (!rq || rq.covered >= rq.def.headcount) continue;

    const elig1903 = ctx.eligibility.get('19:00-03:00') || new Map();
    const cands = [];
    for (const a of ctx.agents) {
      const el = elig1903.get(a.id);
      if (!el) continue; // Κ9: ΜΟΝΟ από τη λίστα
      const plan = w.plans.get(a.id);
      if (plan.elig1903Used >= el.maxPerWeek) continue;
      // Pass A (πριν τις απαιτήσεις): οι «όχι μόνος» δεν αξιολογούνται ακόμα
      if (opts.skipNotAlone && el.notAlone) continue;
      // Πάνω από 1 φορά/εβδομάδα ΜΟΝΟ ΣΥΝΕΧΟΜΕΝΑ (15/07/2026): η 2η+ 19:00-03:00
      // μπαίνει μόνο αμέσως μετά την προηγούμενη (π.χ. Δευ+Τρι), και μετά
      // τη σειρά ακολουθεί ρεπό — η επόμενη μέρα πρέπει να χωράει το ρεπό
      if (plan.elig1903Used >= 1) {
        if (!(d > 0 && is1903(plan.days[d - 1]))) continue;
        if (d + 1 < 7 && plan.days[d + 1] && plan.days[d + 1].type === 'work') continue;
      }
      // Κ9 υπερισχύει ατομικών περιορισμών ωραρίου — όχι όμως των Κ2/Κ6/Κ8/Κ10
      if (!canPlace(w, plan, d, '19:00', '03:00', { override1903: true })) continue;
      // Αγγελή: όχι μόνη στο γραφείο σε ΚΑΜΙΑ ώρα της βάρδιας
      if (el.notAlone && el.location === 'office') {
        const iv = officeCover(d, a.id);
        if (!coveredContinuously(iv, toMin('19:00'), toMin('19:00') + 8 * 60)) continue;
      }
      const st = agentState(w, a.id);
      let score = 100 - st.count1903 * 5 - plan.elig1903Used * 20;
      // Προτίμησε να ΚΛΕΙΣΕΙ η σειρά με τον χθεσινό (ομαδοποίηση — 15/07/2026)
      if (d > 0 && is1903(plan.days[d - 1])) score += 30;
      // Ρίζου: προτίμησέ την τις εβδομάδες απογεύματος
      if (rule(a, 'weekly_alternation') && st.rizouMode === 'morning') score -= 25;
      score += (workTarget(plan) - assignedCount(plan)) * 4;
      // Κυριακή: εναλλαγή ώστε κανείς να μην «καίει» το όριο 2 Κυριακών/μήνα
      if (d === 6) score -= ((st.sundays || {})[w.dates[6].slice(0, 7)] || 0) * 15;
      cands.push({ a, el, score });
    }

    if (cands.length === 0) {
      // Στο pass A δεν αναφέρεται ακάλυπτο — θα ξαναδοκιμάσει το pass B
      if (!opts.skipNotAlone) {
        w.report.uncovered.push({ date: w.dates[d], start: '19:00', end: '03:00', label: rq.def.label });
      }
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

  // Μετά από ΣΕΙΡΑ 2+ συνεχόμενων 19:00-03:00 → ΡΕΠΟ την επόμενη μέρα
  // (15/07/2026). Τρέχει και στα ΔΥΟ περάσματα — αλλιώς οι απαιτήσεις που
  // μεσολαβούν μπορούν να πιάσουν τη μέρα του ρεπό. Αν η σειρά τελειώνει
  // Κυριακή, το ρεπό οφείλεται στην επόμενη εβδομάδα (pendingNightRest).
  {
    for (const [agentId] of (ctx.eligibility.get('19:00-03:00') || new Map())) {
      const plan = w.plans.get(agentId);
      if (!plan) continue;
      let d = 0;
      while (d < 7) {
        if (is1903(plan.days[d])) {
          let len = 1;
          while (d + len < 7 && is1903(plan.days[d + len])) len++;
          if (len >= 2) {
            const restDay = d + len;
            if (restDay < 7) {
              if (!plan.days[restDay]) {
                markOff(w, plan, restDay, 'night_rest');
                plan.offNeeded = Math.max(0, plan.offNeeded - 1);
              }
            } else {
              plan.pendingNightRest = Math.max(plan.pendingNightRest || 0, 1);
            }
          }
          d += len;
        } else {
          d++;
        }
      }
    }
  }
}

// Φάση 7: συμπλήρωση — ΟΛΟΙ οι ενεργοί φτάνουν τις 5 εργάσιμες (Κ2,
// απόφαση προϊσταμένου 09/07/2026), με λογική βάρδια βάσει κανόνων/Σ4.
function phaseFillers(w, reqByDay) {
  const { ctx } = w;
  for (const a of ctx.agents) {
    const plan = w.plans.get(a.id);

    // ΣΚ MAX = HARD (14/07/2026): τα Σαββατοκύριακα δουλεύουν ΜΟΝΟ όσοι
    // καλύπτουν τις απαιτήσεις του πίνακα — ΚΑΝΕΝΑΣ filler ΣΚ. Αν κάποιος
    // δεν φτάνει τις 5 εργάσιμες μέσα στην εβδομάδα, μένει με παραπάνω
    // ρεπό και αναφέρεται (τα αιτήματα ρεπό/άδειες το δικαιολογούν).
    for (const d of [0, 1, 2, 3, 4]) {
      if (assignedCount(plan) >= workTarget(plan)) break;
      if (plan.days[d]) continue;

      // Υποψήφιες βάρδιες με σειρά προτίμησης
      let shifts = [];
      if (a.fixedStart && !a.fixedDays) {
        shifts = [[a.fixedStart, a.fixedEnd]]; // π.χ. Σταθοπούλου 16:00-24:00
      } else if (a.departments.includes('supervisor')) {
        // Supervisors: η επιπλέον βάρδια πάει ΠΡΩΙ μαζί με τον πρωινό —
        // απόγευμα μόνο ο ένας του slot 15:00-23:00 (13/07/2026)
        shifts = [['07:00', '15:00'], ...FILLER_MORNING];
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

      // Πέρασμα 0: μόνο ωράρια που ΔΕΝ αχρηστεύουν γειτονική κενή μέρα
      // (νεκρή μέρα = αναγκαστικό 3ο ρεπό). Πέρασμα 1: ό,τι επιτρέπεται.
      outer:
      for (const pass of [0, 1]) {
        for (const [s, e] of shifts) {
          const telework = a.workLocation === 'home';
          if (!canPlace(w, plan, d, s, e, { telework })) continue;
          if (pass === 0 && killsAdjacentDay(w, plan, d, s, e)) continue;
          const c = fillerColor(ctx, a, d, s, e);
          place(w, plan, d, {
            start: s, end: e,
            label: telework ? 'ΤΗΛΕΡΓΑΣΙΑ' : null,
            location: telework ? 'home' : 'office',
            filler: true, ...c
          });
          break outer;
        }
      }
    }

    // Όσες μέρες έμειναν κενές μετά τον στόχο → ρεπό (πέρα από τα 2 = σημείωση)
    for (let d = 0; d < 7; d++) {
      if (!plan.days[d]) markOff(w, plan, d, 'repo');
    }
  }

  // Πέρασμα ΕΠΙΔΙΟΡΘΩΣΗΣ (HARD 2 ρεπό — 15/07/2026): όποιος έμεινε κάτω από
  // τον στόχο του με ΠΕΡΙΤΤΑ generator-ρεπό καθημερινής, τα ξαναδοκιμάζουμε
  // ως βάρδιες — η κατανομή ρεπό μπορεί να είχε κλειδώσει μέρα που τελικά
  // ήταν εργάσιμη (π.χ. το ΣΚ seat ήρθε αλλού απ' ό,τι υπέθεσε)
  for (const a of ctx.agents) {
    const plan = w.plans.get(a.id);
    let deficit = workTarget(plan) - assignedCount(plan);
    if (deficit <= 0) continue;
    for (let d = 0; d < 5 && deficit > 0; d++) {
      const e = plan.days[d];
      if (!e || e.type !== 'off' || e.reason !== 'repo') continue;
      plan.days[d] = null; // δοκιμαστικό ξεκλείδωμα
      let placed = false;
      const alt = rule(a, 'weekly_alternation');
      const wantMorning = rule(a, 'only_morning') ? true : alt ? agentState(w, a.id).rizouMode === 'morning' : !rule(a, 'only_afternoon');
      const shifts = a.fixedStart && !a.fixedDays
        ? [[a.fixedStart, a.fixedEnd]]
        : (wantMorning ? [...FILLER_MORNING, ...FILLER_AFTERNOON] : [...FILLER_AFTERNOON, ...FILLER_MORNING]);
      for (const [s, e2] of shifts) {
        const telework = a.workLocation === 'home';
        if (canPlace(w, plan, d, s, e2, { telework })) {
          const c = fillerColor(ctx, a, d, s, e2);
          place(w, plan, d, {
            start: s, end: e2,
            label: telework ? 'ΤΗΛΕΡΓΑΣΙΑ' : null,
            location: telework ? 'home' : 'office',
            filler: true, ...c
          });
          placed = true;
          deficit--;
          break;
        }
      }
      if (!placed) markOff(w, plan, d, 'repo'); // επαναφορά
    }
    if (deficit > 0) {
      w.report.soft.push(`${a.name}: μόνο ${assignedCount(plan)}/${workTarget(plan)} εργάσιμες — δεν βρέθηκε επιτρεπτή βάρδια για ${deficit} μέρα/ες.`);
    }
  }

  // Πέρασμα ΣΚ WIN-WIN (15/07/2026): όποιος ΑΚΟΜΑ έχει έλλειμμα (μένει με 3ο
  // ρεπό) ΚΑΙ υπάρχει ΑΚΑΛΥΠΤΟ requirement slot ΣΚ που δικαιούται → τον βάζει
  // εκεί. Λύνει ΤΑΥΤΟΧΡΟΝΑ «ακριβώς 2 ρεπό» + «ΣΚ MIN καλυμμένο», ΧΩΡΙΣ να
  // σπάει το ΣΚ MAX (γεμίζει μόνο ΔΗΛΩΜΕΝΗ, ακάλυπτη θέση του πίνακα).
  if (reqByDay) {
    for (const a of ctx.agents) {
      const plan = w.plans.get(a.id);
      let deficit = workTarget(plan) - assignedCount(plan);
      if (deficit <= 0) continue;
      for (const d of [5, 6]) {
        if (deficit <= 0) break;
        const cur = plan.days[d];
        // Μόνο πάνω σε παραγόμενο ρεπό (όχι fixed_off/night_rest/αίτημα/κενό-άδεια)
        if (!cur || cur.type !== 'off' || cur.reason !== 'repo') continue;
        for (const rq of reqByDay[d]) {
          if (deficit <= 0) break;
          if (rq.covered >= rq.def.headcount) continue;
          if (rq.def.start === '23:00' || rq.def.start === '19:00') continue;
          if (!deptMatch(a, rq.def.department)) continue;
          if (rq.def.skill && !a.skills.has(rq.def.skill)) continue;
          const opts = rq.def.period
            ? (rq.def.period === 'morning'
                ? [[rq.def.start, rq.def.end], ...FILLER_MORNING.filter(([s]) => s !== rq.def.start)]
                : [[rq.def.start, rq.def.end], ...FILLER_AFTERNOON.filter(([s]) => s !== rq.def.start)])
            : [[rq.def.start, rq.def.end]];
          const telework = a.workLocation === 'home';
          plan.days[d] = null; // ξεκλείδωσε το ρεπό ΠΡΙΝ το probe (αλλιώς canPlace=false)
          // allowSundayOver: το «ακριβώς 2 ρεπό» υπερισχύει του ορίου Κυριακών
          // (απόφαση 15/07/2026) — ΜΟΝΟ όταν αυτή η μέρα φτάνει τον agent
          // ΑΚΡΙΒΩΣ στις 5 (deficit==1). Αν θα έμενε κι άλλο κοντός (π.χ.
          // νυχτερινός με πολλές αναπαύσεις), δεν «καίμε» 3η Κυριακή τζάμπα.
          const allowSundayOver = deficit === 1;
          let shift = null;
          for (const [s, e] of opts) {
            if (canPlace(w, plan, d, s, e, { telework, allowSundayOver })) { shift = [s, e]; break; }
          }
          if (!shift) { markOff(w, plan, d, 'repo'); continue; } // επαναφορά
          place(w, plan, d, {
            start: shift[0], end: shift[1],
            skill: rq.def.skill, reqLabel: rq.def.label, usedForReq: true,
            label: [telework ? 'ΤΗΛΕΡΓΑΣΙΑ' : null, rq.def.label === 'International' ? 'INTERNATIONAL' : null].filter(Boolean).join(' ') || null,
            location: telework ? 'home' : 'office',
            roleId: rq.def.roleId, color: rq.def.color
          });
          rq.covered++;
          deficit--;
          // Αφαίρεσε το slot από τα ακάλυπτα του report
          const ui = w.report.uncovered.findIndex(
            (u) => u.date === w.dates[d] && u.start === rq.def.start && u.end === rq.def.end
          );
          if (ui >= 0) w.report.uncovered.splice(ui, 1);
        }
      }
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

    // Streak: συνεχόμενες εργάσιμες μέχρι και την Κυριακή — η άδεια/ασθένεια
    // μετράει ως εργάσιμη (13/07/2026)
    let streak = 0;
    for (let d = 6; d >= 0; d--) {
      if (countsAsWork(plan, d)) streak++;
      else break;
    }
    if (streak === 7) streak += st.streak; // ολόκληρη εβδομάδα (π.χ. πλήρης άδεια) — συνεχίζει από την προηγούμενη

    // Λήξη τελευταίας βάρδιας
    let lastEndAbs = st.lastEndAbs;
    for (let d = 0; d < 7; d++) {
      const abs = entryAbs(w, plan, d);
      if (abs) lastEndAbs = Math.max(lastEndAbs, abs.endAbs);
    }

    // ΣΚ που δούλεψε
    let wknd = 0;
    for (const d of [5, 6]) if (worked(plan, d)) wknd++;

    // Μετρητής 06:00-14:00 (δίκαιη εναλλαγή λίστας — 12/07/2026)
    let count62 = st.count62 || 0;
    for (let d = 0; d < 7; d++) {
      const e = plan.days[d];
      if (e && e.type === 'work' && e.start === '06:00' && e.end === '14:00') count62++;
    }

    // Μετρητής Κυριακών ανά μήνα (όριο 2/μήνα — 11/07/2026)
    const sundays = { ...(st.sundays || {}) };
    // Μετρητής ΡΕΠΟ Κυριακής (sunday_worker: το πολύ 1/μήνα — 12/07/2026)
    const sundaysOff = { ...(st.sundaysOff || {}) };
    const mk = w.dates[6].slice(0, 7);
    if (worked(plan, 6)) {
      sundays[mk] = (sundays[mk] || 0) + 1;
    } else {
      const e = plan.days[6];
      const isLeave = e && e.type === 'off' && (e.reason === 'leave' || e.reason === 'sick');
      if (!isLeave) sundaysOff[mk] = (sundaysOff[mk] || 0) + 1;
    }
    // Κράτα μόνο τους 3 πιο πρόσφατους μήνες
    for (const k of Object.keys(sundays).sort().slice(0, -3)) delete sundays[k];
    for (const k of Object.keys(sundaysOff).sort().slice(0, -3)) delete sundaysOff[k];

    next[a.id] = {
      streak,
      lastEndAbs,
      nights: st.nights,
      weekends: st.weekends + wknd,
      count1903: st.count1903,
      count62,
      sundays,
      sundaysOff,
      pendingNightRest: plan.pendingNightRest || 0,
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
          roleName: e.roleName || null,
          location: e.location || 'office', night: e.night || false
        });
      }
    }
  }
  return out;
}

// ==================== ΚΥΡΙΑ ΣΥΝΑΡΤΗΣΗ ΕΒΔΟΜΑΔΑΣ ====================
function generateWeek(ctx, weekStart, state, opts = {}) {
  const w = newWeek(ctx, weekStart, state);
  // Συνεχόμενες μέρες στην αρχή της ΕΠΟΜΕΝΗΣ εβδομάδας όταν είναι γνωστή
  // (εισηγμένη από Excel) — για τον εμπρόσθιο έλεγχο Κ10
  w.nextLead = opts.nextLead || null;
  // Πρώτη έναρξη κάθε agent στην εισηγμένη επόμενη εβδομάδα — εμπρόσθιο Κ8
  w.nextFirstStart = opts.nextFirstStart || null;

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
  phaseNights(w, nightReqByDay); // Κ4, Κ7, Σ3 + υποχρεωτική ανάπαυση
  phase1903(w, reqByDay, { skipNotAlone: true }); // Κ9 pass A: κράτηση θέσης ΠΡΩΤΑ
  // ΣΚ MIN (15/07/2026): οι θέσεις του Σαββατοκύριακου γεμίζουν ΠΡΙΝ τα
  // ρεπό — εξασφαλισμένη κάλυψη, οι «αναγκεμένοι» (με υποχρεωτικά ρεπό
  // καθημερινής) παίρνουν τις θέσεις, και οι υπόλοιποι καθαρά Σαβ+Κυρ ρεπό
  phaseRequirements(w, reqByDay, { days: [5, 6] });
  phaseOffs(w, reqByDay); // ρεπό: Σ2, Σ3, Κ10
  phaseRequirements(w, reqByDay, { days: [0, 1, 2, 3, 4] }); // Κ1 καθημερινές
  phase1903(w, reqByDay); // Κ9 pass B (και Αγγελή, με γνωστή παρουσία)
  phaseFillers(w, reqByDay); // Κ2: όλοι στις 5 εργάσιμες
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

module.exports = { generateWeek, shiftAllowedByRules, rule, deptMatch, REST_MIN, REST_MIN_SPLIT, MAX_STREAK };
