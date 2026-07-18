// Οθόνη Προγράμματος (ΒΗΜΑ 5): preview grid ανά εβδομάδα (ώρες κάθετα,
// μέρες οριζόντια), χειροκίνητες αλλαγές ανάθεσης ΚΑΙ χρώματος, live έλεγχος
// κανόνων (Κ8/Κ10 και προς τις γειτονικές εβδομάδες) με προειδοποίηση —
// όχι μπλοκάρισμα, κόκκινη ένδειξη ακάλυπτων, αποθήκευση στη βάση.
(() => {
  const DAY_GR = ['ΔΕΥΤΕΡΑ', 'ΤΡΙΤΗ', 'ΤΕΤΑΡΤΗ', 'ΠΕΜΠΤΗ', 'ΠΑΡΑΣΚΕΥΗ', 'ΣΑΒΒΑΤΟ', 'ΚΥΡΙΑΚΗ'];
  const OFF_LABELS = { repo: 'ΡΕΠΟ', fixed_off: 'ΡΕΠΟ', rule: 'ΡΕΠΟ', repo_request: 'ΑΙΤΗΜΑ ΡΕΠΟ', leave: 'ΑΔΕΙΑ', sick: 'ΑΣΘΕΝΕΙΑ', night_rest: 'ΡΕΠΟ (μετά βράδυ)' };

  const $ = (id) => document.getElementById(id);
  let meta = { roles: [] };
  let agents = [];
  let period = null;      // {label, weeks:[{start,end}]}
  let weekData = [];      // ανά εβδομάδα: {weekStart, dates[], assignments[], report, dirty, saved}
  let cur = 0;            // δείκτης τρέχουσας εβδομάδας
  let editing = null;     // {isNew, index, date}
  let selColor = null;    // επιλεγμένο χρώμα στο modal
  let validateTimer = null;

  // ---------- Βοηθητικά ----------
  async function api(url, options = {}) {
    const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
    if (r.status === 401) {
      location.href = '/login.html';
      throw new Error('auth');
    }
    return r.json();
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  const toMin = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const timeOk = (t) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t) || t === '24:00';
  const argbToHex = (argb) => '#' + argb.slice(2);
  const textColorFor = (argb) => {
    const r = parseInt(argb.slice(2, 4), 16), g = parseInt(argb.slice(4, 6), 16), b = parseInt(argb.slice(6, 8), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) < 140 ? '#fff' : '#222';
  };
  const fmtD = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return `${d}/${m}`;
  };
  const surname = (full) => (full || '').split(' ')[0];

  // ---------- Φόρτωση ----------
  async function init() {
    const me = await api('/api/me').catch(() => null);
    if (!me || !me.ok) return;
    $('userName').textContent = me.displayName;

    const m = await api('/api/meta');
    if (m.ok) meta = m;
    const ag = await api('/api/agents');
    if (ag.ok) agents = ag.agents;

    try {
      period = JSON.parse(localStorage.getItem('selectedPeriod'));
    } catch { period = null; }
    if (!period || !period.weeks || !period.weeks.length) {
      $('noPeriod').style.display = '';
      return;
    }
    $('schedArea').style.display = '';

    // Φόρτωσε ό,τι είναι ήδη αποθηκευμένο ανά εβδομάδα
    const addDaysStr = (s, n) => {
      const [y, m, d] = s.split('-').map(Number);
      const dt = new Date(y, m - 1, d + n, 12);
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    };
    weekData = [];
    for (const wk of period.weeks) {
      const dates = [];
      for (let i = 0; i < 7; i++) dates.push(addDaysStr(wk.start, i));
      const saved = await api('/api/schedule/week?start=' + wk.start);
      weekData.push({
        weekStart: wk.start,
        dates,
        assignments: saved.saved ? saved.assignments : [],
        report: saved.saved ? saved.report : null,
        dirty: false,
        saved: !!saved.saved
      });
    }
    renderTabs();
    renderWeek();
  }

  // ---------- Tabs ----------
  function renderTabs() {
    const tabs = $('weekTabs');
    tabs.innerHTML = '';
    weekData.forEach((w, i) => {
      const el = document.createElement('div');
      el.className = 'week-tab' + (i === cur ? ' active' : '');
      el.innerHTML = `${fmtD(w.weekStart)}–${fmtD(w.dates[6])}${w.dirty ? ' <span class="dirty">●</span>' : ''}`;
      el.title = w.saved ? 'Αποθηκευμένη' : 'Μη αποθηκευμένη';
      el.addEventListener('click', () => { cur = i; renderTabs(); renderWeek(); });
      tabs.appendChild(el);
    });
    const w = weekData[cur];
    $('statusInfo').textContent = w.assignments.length === 0
      ? 'Κενή εβδομάδα — πάτα «Δημιουργία Προγράμματος»'
      : (w.report && w.report.imported
        ? 'Εισηγμένη από Excel — κρατείται ως έχει'
        : (w.dirty ? 'Μη αποθηκευμένες αλλαγές' : (w.saved ? 'Αποθηκευμένη' : 'Παράχθηκε — δεν έχει αποθηκευτεί')));
  }

  $('prevWeekBtn').addEventListener('click', () => { if (cur > 0) { cur--; renderTabs(); renderWeek(); } });
  $('nextWeekBtn').addEventListener('click', () => { if (cur < weekData.length - 1) { cur++; renderTabs(); renderWeek(); } });

  // ---------- Grid ----------
  // Σπάει ανάθεση σε τμήματα ημέρας (οι νυχτερινές/19:00-03:00 περνούν μεσάνυχτα)
  function segmentsOf(w) {
    const segs = []; // {dayIdx, from, to (λεπτά), aIdx, cont}
    w.assignments.forEach((a, aIdx) => {
      if (a.off) return;
      const d = w.dates.indexOf(a.date);
      if (d === -1) return;
      const s = toMin(a.start);
      let e = toMin(a.end);
      if (e <= s) {
        segs.push({ dayIdx: d, from: s, to: 1440, aIdx, cont: false });
        if (d < 6) segs.push({ dayIdx: d + 1, from: 0, to: e, aIdx, cont: true });
      } else {
        segs.push({ dayIdx: d, from: s, to: e, aIdx, cont: false });
      }
    });
    return segs;
  }

  function renderWeek() {
    const w = weekData[cur];
    const grid = $('grid');
    grid.innerHTML = '';

    // Πακετάρισμα σε «λωρίδες» ανά μέρα ώστε επικαλυπτόμενες βάρδιες να
    // μπαίνουν σε διπλανές στήλες
    const segs = segmentsOf(w);
    const lanes = [[], [], [], [], [], [], []]; // ανά μέρα: λίστα από λωρίδες, καθεμία λίστα segs
    for (let d = 0; d < 7; d++) {
      const daySegs = segs.filter((s) => s.dayIdx === d).sort((a, b) => a.from - b.from || b.to - a.to);
      for (const sg of daySegs) {
        // Σύγκριση σε ΣΤΡΟΓΓΥΛΕΜΕΝΕΣ ώρες: τα blocks καταλαμβάνουν ωριαίες
        // ζώνες (όπως στο Excel), οπότε π.χ. 08:00-15:30 και 15:30-23:30
        // μοιράζονται τη ζώνη 15:00-16:00 και δεν χωρούν στην ίδια λωρίδα
        let laneIdx = lanes[d].findIndex((lane) => Math.ceil(lane[lane.length - 1].to / 60) <= Math.floor(sg.from / 60));
        if (laneIdx === -1) {
          lanes[d].push([]);
          laneIdx = lanes[d].length - 1;
        }
        lanes[d][laneIdx].push(sg);
        sg.lane = laneIdx;
      }
      if (lanes[d].length === 0) lanes[d].push([]);
    }

    const laneCount = lanes.map((l) => l.length);
    const totalLanes = laneCount.reduce((a, b) => a + b, 0);
    const colStart = [1]; // στήλη grid όπου αρχίζει κάθε μέρα (0-based μετά τη στήλη ωρών)
    for (let d = 0; d < 7; d++) colStart.push(colStart[d] + laneCount[d]);

    grid.style.gridTemplateColumns = `70px repeat(${totalLanes}, minmax(96px, 1fr))`;
    grid.style.gridTemplateRows = `34px repeat(24, 26px)`;

    // Γωνία + ωριαίες ζώνες
    const corner = document.createElement('div');
    corner.className = 'corner-cell';
    grid.appendChild(corner);
    for (let h = 0; h < 24; h++) {
      const c = document.createElement('div');
      c.className = 'hour-cell';
      c.style.gridRow = String(h + 2);
      c.style.gridColumn = '1';
      c.textContent = `${String(h).padStart(2, '0')}:00`;
      grid.appendChild(c);
    }

    // Ημέρες: κεφαλίδες + φόντο + blocks
    const uncByDay = countUncoveredByDay(w);
    for (let d = 0; d < 7; d++) {
      const head = document.createElement('div');
      head.className = 'day-head';
      head.style.gridRow = '1';
      head.style.gridColumn = `${colStart[d] + 1} / span ${laneCount[d]}`;
      head.innerHTML = `<span>${DAY_GR[d]} ${fmtD(w.dates[d])}</span>` +
        (uncByDay[d] ? `<span class="unc-badge" title="Ακάλυπτες απαιτήσεις">${uncByDay[d]}</span>` : '') +
        `<button title="Προσθήκη ανάθεσης">+</button>`;
      head.querySelector('button').addEventListener('click', () => openEdit(null, w.dates[d]));
      grid.appendChild(head);

      // Κελιά φόντου (για τις γραμμές ωρών)
      for (let lane = 0; lane < laneCount[d]; lane++) {
        for (let h = 0; h < 24; h++) {
          const bg = document.createElement('div');
          bg.className = 'grid-bg' + (lane === 0 ? ' day-start' : '');
          bg.style.gridRow = String(h + 2);
          bg.style.gridColumn = String(colStart[d] + 1 + lane);
          grid.appendChild(bg);
        }
      }
    }

    // Blocks αναθέσεων
    for (const sg of segs) {
      const a = w.assignments[sg.aIdx];
      const rowStart = Math.floor(sg.from / 60) + 2;
      const rowEnd = Math.ceil(sg.to / 60) + 2;
      const blk = document.createElement('div');
      blk.className = 'blk' + (a.isManualEdit ? ' manual' : '') + (a.color ? '' : ' nocolor');
      if (a.color) {
        blk.style.background = argbToHex(a.color);
        blk.style.color = textColorFor(a.color);
      }
      blk.style.gridRow = `${rowStart} / ${rowEnd}`;
      blk.style.gridColumn = String(colStart[sg.dayIdx] + 1 + sg.lane);
      const name = surname(a.agentName || (agents.find((x) => x.id === a.agentId) || {}).full_name);
      blk.innerHTML = `<div class="nm">${sg.cont ? '↩ ' : ''}${esc(name)}</div>` +
        `<div class="tm">${a.start}–${a.end}</div>` +
        (a.label ? `<div class="lb">${esc(a.label)}</div>` : '');
      blk.title = `${a.agentName || name} ${a.start}-${a.end}` + (a.reqLabel ? ` · ${a.reqLabel}` : '') + (a.label ? ` · ${a.label}` : '');
      blk.addEventListener('click', () => openEdit(sg.aIdx, a.date));
      grid.appendChild(blk);
    }

    renderOffs(w);
    scheduleValidate();
  }

  function countUncoveredByDay(w) {
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (const u of w.lastUncovered || []) {
      const d = w.dates.indexOf(u.date);
      if (d >= 0) counts[d] += u.missing || 1;
    }
    return counts;
  }

  function renderOffs(w) {
    const area = $('offsArea');
    area.innerHTML = '';
    for (let d = 0; d < 7; d++) {
      const offs = w.assignments.filter((a) => a.off && a.date === w.dates[d]);
      if (!offs.length) continue;
      const div = document.createElement('div');
      div.style.marginBottom = '.35rem';
      div.innerHTML = `<strong>${DAY_GR[d].slice(0, 3)} ${fmtD(w.dates[d])}:</strong> ` +
        offs.map((o) => `<span class="off-chip ${esc(o.reason || '')}">${esc(surname(o.agentName))} — ${OFF_LABELS[o.reason] || 'ΡΕΠΟ'}</span>`).join('');
      area.appendChild(div);
    }
    if (!area.innerHTML) area.innerHTML = '<span class="muted">—</span>';
  }

  // ---------- Live validation ----------
  function scheduleValidate() {
    clearTimeout(validateTimer);
    validateTimer = setTimeout(runValidate, 350);
  }

  async function runValidate() {
    const w = weekData[cur];
    const prev = cur > 0 && weekData[cur - 1].assignments.length ? weekData[cur - 1].assignments : undefined;
    const next = cur < weekData.length - 1 && weekData[cur + 1].assignments.length ? weekData[cur + 1].assignments : undefined;
    const d = await api('/api/schedule/validate', {
      method: 'POST',
      body: JSON.stringify({
        weekStart: w.weekStart,
        assignments: w.assignments,
        prevAssignments: prev,
        nextAssignments: next
      })
    });
    if (!d.ok) return;

    w.lastUncovered = d.uncovered;
    $('uncCount').textContent = d.uncovered.length ? `(${d.uncovered.length})` : '';
    $('uncList').innerHTML = d.uncovered
      .map((u) => `<li>${fmtD(u.date)} ${u.start}–${u.end} <strong>${esc(u.label)}</strong>${u.missing > 1 ? ' ×' + u.missing : ''}</li>`)
      .join('');
    $('uncOk').style.display = d.uncovered.length ? 'none' : '';

    $('warnCount').textContent = d.warnings.length ? `(${d.warnings.length})` : '';
    $('warnList').innerHTML = d.warnings
      .map((x) => `<li>${x.date ? fmtD(x.date) + ' — ' : ''}${esc(x.text)}</li>`)
      .join('');
    $('warnOk').style.display = d.warnings.length ? 'none' : '';

    // Ανανέωση κόκκινων badges στις κεφαλίδες ημερών (χωρίς πλήρες redraw)
    const uncByDay = countUncoveredByDay(w);
    document.querySelectorAll('.day-head').forEach((head, d2) => {
      const old = head.querySelector('.unc-badge');
      if (old) old.remove();
      if (uncByDay[d2]) {
        const b = document.createElement('span');
        b.className = 'unc-badge';
        b.textContent = uncByDay[d2];
        head.insertBefore(b, head.querySelector('button'));
      }
    });
  }

  // ---------- Modal επεξεργασίας ----------
  function openEdit(aIdx, date) {
    const w = weekData[cur];
    editing = { isNew: aIdx === null, index: aIdx, date };
    const a = aIdx !== null ? w.assignments[aIdx] : null;

    $('editTitle').textContent = a ? 'Επεξεργασία ανάθεσης' : 'Νέα ανάθεση';
    $('editErr').textContent = '';
    $('deleteBtn').style.display = a ? '' : 'none';

    const sel = $('eAgent');
    sel.innerHTML = '';
    for (const ag of agents) {
      const o = document.createElement('option');
      o.value = ag.id;
      o.textContent = ag.full_name;
      sel.appendChild(o);
    }
    if (a) sel.value = a.agentId;

    $('eDate').value = date;
    $('eStart').value = a ? a.start : '08:00';
    $('eEnd').value = a ? a.end : '16:00';
    $('eLabel').value = a && a.label && ['ΤΗΛΕΡΓΑΣΙΑ', 'INTERNATIONAL', 'ΝΥΧΤΕΡΙΝΗ', 'ΣΠΑΣΤΟ'].includes(a.label) ? a.label : '';

    // Παλέτα χρωμάτων (ενότητα 3) — το χρώμα ΔΕΝ δένεται με τον agent
    selColor = a ? (a.color || null) : null;
    const sw = $('eSwatches');
    sw.innerHTML = '';
    const noneBtn = document.createElement('div');
    noneBtn.className = 'swatch' + (selColor === null ? ' sel' : '');
    noneBtn.style.background = 'repeating-linear-gradient(45deg,#fff,#fff 5px,#eee 5px,#eee 10px)';
    noneBtn.title = 'Χωρίς χρώμα';
    noneBtn.addEventListener('click', () => { selColor = null; refreshSwatches(); });
    sw.appendChild(noneBtn);
    for (const r of meta.roles) {
      const b = document.createElement('div');
      b.className = 'swatch' + (selColor === r.color_argb ? ' sel' : '');
      b.style.background = argbToHex(r.color_argb);
      b.title = r.name;
      b.dataset.color = r.color_argb;
      b.dataset.roleId = r.id;
      b.addEventListener('click', () => { selColor = r.color_argb; refreshSwatches(); });
      sw.appendChild(b);
    }
    function refreshSwatches() {
      sw.querySelectorAll('.swatch').forEach((el) => {
        el.classList.toggle('sel', (el.dataset.color || null) === selColor);
      });
    }

    $('editBackdrop').style.display = 'flex';
  }

  function closeEdit() {
    $('editBackdrop').style.display = 'none';
    editing = null;
  }

  $('editCancelBtn').addEventListener('click', closeEdit);
  $('editBackdrop').addEventListener('click', (e) => { if (e.target === $('editBackdrop')) closeEdit(); });

  $('editSaveBtn').addEventListener('click', () => {
    if (!editing) return;
    const w = weekData[cur];
    const start = $('eStart').value.trim();
    const end = $('eEnd').value.trim();
    if (!timeOk(start) || !timeOk(end)) {
      $('editErr').textContent = 'Ώρες σε μορφή HH:MM (η λήξη μπορεί να είναι 24:00 ή μετά τα μεσάνυχτα, π.χ. 03:00)';
      return;
    }
    const agentId = Number($('eAgent').value);
    const agent = agents.find((x) => x.id === agentId);
    const roleEl = [...$('eSwatches').children].find((el) => (el.dataset.color || null) === selColor && el.dataset.roleId);

    const obj = {
      agentId,
      agentName: agent ? agent.full_name : '',
      date: editing.date,
      start,
      end,
      label: $('eLabel').value || null,
      color: selColor,
      roleId: roleEl ? Number(roleEl.dataset.roleId) : null,
      location: $('eLabel').value === 'ΤΗΛΕΡΓΑΣΙΑ' ? 'home' : 'office',
      isManualEdit: true
    };

    if (editing.isNew) {
      // Αν ο agent είχε ρεπό εκείνη τη μέρα, το ρεπό αφαιρείται (τώρα δουλεύει)
      w.assignments = w.assignments.filter((x) => !(x.off && x.agentId === agentId && x.date === editing.date));
      w.assignments.push(obj);
    } else {
      const old = w.assignments[editing.index];
      w.assignments[editing.index] = { ...old, ...obj };
      if (old.agentId !== agentId) {
        // Άλλαξε ο agent: καθάρισε τυχόν ρεπό του νέου εκείνη τη μέρα
        w.assignments = w.assignments.filter((x) => !(x.off && x.agentId === agentId && x.date === editing.date));
      }
    }
    w.dirty = true;
    closeEdit();
    renderTabs();
    renderWeek();
  });

  $('deleteBtn').addEventListener('click', () => {
    if (!editing || editing.isNew) return;
    const w = weekData[cur];
    w.assignments.splice(editing.index, 1);
    w.dirty = true;
    closeEdit();
    renderTabs();
    renderWeek();
  });

  // ---------- Δημιουργία / Αποθήκευση ----------
  $('generateBtn').addEventListener('click', async () => {
    const anyContent = weekData.some((w) => w.assignments.length > 0);
    if (anyContent && !confirm('Θα ΑΝΤΙΚΑΤΑΣΤΑΘΕΙ το τρέχον πρόγραμμα όλης της περιόδου με νέο. Συνέχεια;')) return;

    $('generateBtn').disabled = true;
    $('generateBtn').textContent = 'Παραγωγή…';
    try {
      const d = await api('/api/schedule/generate', {
        method: 'POST',
        body: JSON.stringify({
          from: period.weeks[0].start,
          to: period.weeks[period.weeks.length - 1].end
        })
      });
      if (!d.ok) return toast('Σφάλμα: ' + d.error);
      d.weeks.forEach((gw, i) => {
        if (weekData[i]) {
          weekData[i].assignments = gw.assignments;
          weekData[i].report = gw.report;
          // Εισηγμένη από Excel εβδομάδα: κρατήθηκε ως έχει — είναι ήδη
          // αποθηκευμένη, δεν χρειάζεται ξανά αποθήκευση
          const imported = gw.report && gw.report.imported;
          weekData[i].dirty = !imported;
          weekData[i].saved = !!imported;
        }
      });
      toast('Το πρόγραμμα δημιουργήθηκε — δες τις εβδομάδες και αποθήκευσε');
      renderTabs();
      renderWeek();
    } finally {
      $('generateBtn').disabled = false;
      $('generateBtn').textContent = 'Δημιουργία Προγράμματος';
    }
  });

  async function saveWeek(i) {
    const w = weekData[i];

    // HARD Κ8 (18/07/2026): ΔΕΝ αποθηκεύεται εβδομάδα με ανάπαυση <11h.
    // Φρέσκος έλεγχος τη στιγμή του save (το live validation είναι debounced).
    // Το νόμιμο σπαστό (π.χ. Κουλογιάννης 9h) εξαιρείται ήδη στο backend.
    const prev = i > 0 && weekData[i - 1].assignments.length ? weekData[i - 1].assignments : undefined;
    const next = i < weekData.length - 1 && weekData[i + 1].assignments.length ? weekData[i + 1].assignments : undefined;
    const v = await api('/api/schedule/validate', {
      method: 'POST',
      body: JSON.stringify({ weekStart: w.weekStart, assignments: w.assignments, prevAssignments: prev, nextAssignments: next })
    });
    if (v.ok) {
      const k8 = (v.warnings || []).filter((x) => x.code === 'K8');
      if (k8.length) {
        alert('⛔ Δεν αποθηκεύεται — υπάρχει ανάπαυση κάτω από 11 ώρες (Κ8):\n\n'
          + k8.map((x) => '• ' + x.text).join('\n')
          + '\n\nΔιόρθωσε τις βάρδιες (π.χ. πρωί μετά από απόγευμα) και ξαναδοκίμασε.');
        throw new Error('K8_BLOCK');
      }
    }

    const d = await api('/api/schedule/save', {
      method: 'POST',
      body: JSON.stringify({ weekStart: w.weekStart, assignments: w.assignments, report: w.report })
    });
    if (!d.ok) throw new Error(d.error);
    w.dirty = false;
    w.saved = true;
  }

  $('saveWeekBtn').addEventListener('click', async () => {
    try {
      await saveWeek(cur);
      toast('Η εβδομάδα αποθηκεύτηκε');
      renderTabs();
    } catch (e) {
      if (e.message === 'K8_BLOCK') return; // ήδη έγινε alert
      toast('Σφάλμα αποθήκευσης: ' + e.message);
    }
  });

  $('saveAllBtn').addEventListener('click', async () => {
    try {
      // Με τη σειρά, ώστε η κατάσταση κάθε εβδομάδας να χτίζει στη σωστή
      // προηγούμενη — οι ήδη αποθηκευμένες/εισηγμένες χωρίς αλλαγές παραλείπονται
      for (let i = 0; i < weekData.length; i++) {
        if (weekData[i].assignments.length && (weekData[i].dirty || !weekData[i].saved)) await saveWeek(i);
      }
      toast('Όλη η περίοδος αποθηκεύτηκε');
      renderTabs();
    } catch (e) {
      if (e.message === 'K8_BLOCK') return; // ήδη έγινε alert
      toast('Σφάλμα αποθήκευσης: ' + e.message);
    }
  });

  // ---------- Excel export (ΒΗΜΑ 6) ----------
  // Στέλνουμε τις αναθέσεις ΟΠΩΣ φαίνονται στο preview — ό,τι βλέπεις
  // (συμπεριλαμβανομένων μη αποθηκευμένων αλλαγών και χρωμάτων), αυτό γράφεται.
  async function download(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || 'Σφάλμα εξαγωγής');
    }
    const dispo = r.headers.get('Content-Disposition') || '';
    const m = dispo.match(/filename="([^"]+)"/);
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : 'Program.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  $('exportWeekBtn').addEventListener('click', async () => {
    const w = weekData[cur];
    if (!w.assignments.length) return toast('Η εβδομάδα είναι κενή — δημιούργησε πρόγραμμα πρώτα');
    try {
      await download('/api/export/week', { weekStart: w.weekStart, assignments: w.assignments });
    } catch (e) {
      toast(e.message);
    }
  });

  $('exportPeriodBtn').addEventListener('click', async () => {
    const weeks = weekData
      .filter((w) => w.assignments.length)
      .map((w) => ({ weekStart: w.weekStart, assignments: w.assignments }));
    if (!weeks.length) return toast('Δεν υπάρχει πρόγραμμα — δημιούργησε πρώτα');
    try {
      await download('/api/export/period', { weeks });
    } catch (e) {
      toast(e.message);
    }
  });

  // ---------- Εισαγωγή Excel υπάρχοντος προγράμματος ----------
  // Διαβάζει το αρχείο εβδομάδας που έχει ήδη βγει (π.χ. την εβδομάδα ΠΡΙΝ
  // την περίοδο) ώστε ο generator να τηρεί Κ8/Κ10 στα σύνορα.
  $('importBtn').addEventListener('click', () => {
    const def = period ? (() => {
      const [y, m, d] = period.weeks[0].start.split('-').map(Number);
      const dt = new Date(y, m - 1, d - 7, 12);
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    })() : '';
    const ws = prompt('Δευτέρα της εβδομάδας του αρχείου (YYYY-MM-DD):', def);
    if (!ws) return;
    $('importFile').dataset.weekStart = ws.trim();
    $('importFile').value = '';
    $('importFile').click();
  });

  $('importFile').addEventListener('change', async () => {
    const file = $('importFile').files[0];
    if (!file) return;
    const weekStart = $('importFile').dataset.weekStart;
    const buf = await file.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    const d = await api('/api/import/week', {
      method: 'POST',
      body: JSON.stringify({ weekStart, fileBase64: btoa(bin) })
    });
    if (!d.ok) return toast('Σφάλμα εισαγωγής: ' + d.error);
    let msg = `Εισήχθησαν ${d.imported} βάρδιες για την εβδομάδα ${d.weekStart}`;
    if (d.unmatchedNames.length) msg += ` — ΔΕΝ αναγνωρίστηκαν: ${d.unmatchedNames.slice(0, 5).join(', ')}`;
    toast(msg);
    // Αν η εβδομάδα είναι μέσα στην περίοδο, ξαναφόρτωσέ τη
    const idx = weekData.findIndex((w) => w.weekStart === weekStart);
    if (idx >= 0) {
      const saved = await api('/api/schedule/week?start=' + weekStart);
      if (saved.saved) {
        weekData[idx].assignments = saved.assignments;
        weekData[idx].saved = true;
        weekData[idx].dirty = false;
        if (idx === cur) renderWeek();
        renderTabs();
      }
    }
  });

  // ---------- Εκκίνηση ----------
  $('logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    location.href = '/login.html';
  });

  init();
})();
