// Οθόνη Agents: λίστα με φίλτρα, CRUD, απενεργοποίηση (soft delete),
// επεξεργασία constraints ανά agent.
(() => {
  const DAY_NAMES = { 1: 'Δευ', 2: 'Τρι', 3: 'Τετ', 4: 'Πεμ', 5: 'Παρ', 6: 'Σαβ', 7: 'Κυρ' };

  let meta = { skills: [] };
  let editingId = null; // null = νέος agent
  let canEditAgents = true; // δικαίωμα «Επεξεργασία agent» (από /api/me)

  const $ = (id) => document.getElementById(id);

  // ---------- Βοηθητικά ----------
  async function api(url, options = {}) {
    const r = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    if (r.status === 401) {
      location.href = '/login.html';
      throw new Error('Απαιτείται σύνδεση');
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

  // ---------- Έλεγχος σύνδεσης ----------
  async function checkAuth() {
    const d = await api('/api/me').catch(() => null);
    if (!d || !d.ok) return;
    $('userName').textContent = d.displayName;
    canEditAgents = d.canEditAgents !== false; // δικαίωμα «Επεξεργασία agent»
  }

  $('logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    location.href = '/login.html';
  });

  // ---------- Φόρτωση λίστας ----------
  async function loadAgents() {
    const params = new URLSearchParams();
    const q = $('fltSearch').value.trim();
    if (q) params.set('q', q);
    if ($('fltDept').value) params.set('department', $('fltDept').value);
    if ($('fltCompany').value) params.set('company', $('fltCompany').value);
    params.set('active', $('fltInactive').checked ? 'all' : '1');

    const d = await api('/api/agents?' + params.toString());
    if (!d.ok) return toast('Σφάλμα: ' + d.error);
    renderTable(d.agents);
    $('countInfo').textContent = d.agents.length + ' agents';
  }

  function renderTable(agents) {
    const tbody = document.querySelector('#agentsTable tbody');
    tbody.innerHTML = '';
    for (const a of agents) {
      const tr = document.createElement('tr');
      if (!a.active) tr.classList.add('inactive');

      const depts = a.departments
        .map((dp) => `<span class="badge dept-${esc(dp)}">${esc(dp)}</span>`)
        .join('');
      const skills = a.skills.map((s) => `<span class="badge skill">${esc(s.name)}</span>`).join('');
      const night = a.can_night === 1 ? '<span class="badge night">Ναι</span>' : a.can_night === 0 ? 'Όχι' : '<span class="muted">;</span>';

      let fixed = '';
      if (a.fixed_shift_start) {
        fixed = a.fixed_shift_start + '–' + a.fixed_shift_end;
        if (a.fixed_days) fixed += '<br><span class="muted">' + a.fixed_days.map((x) => DAY_NAMES[x]).join(', ') + '</span>';
      }
      const extras = [];
      if (a.fixed_days_off) extras.push('Ρεπό: ' + a.fixed_days_off.map((x) => DAY_NAMES[x]).join('+'));
      if (a.weekend_shift) extras.push('ΣΚ: ' + a.weekend_shift);
      if (a.work_location === 'home') extras.push('Τηλεργασία');

      const consText = a.constraints.map((c) => esc(c.description)).join('<br>');

      tr.innerHTML = `
        <td><strong>${esc(a.full_name)}</strong>${a.is_new ? ' <span class="badge">νέος</span>' : ''}</td>
        <td>${esc(a.company || '—')}</td>
        <td>${depts}</td>
        <td>${skills || '<span class="muted">—</span>'}</td>
        <td>${night}</td>
        <td>${fixed || '<span class="muted">—</span>'}${extras.length ? '<br><span class="muted">' + extras.join(' · ') + '</span>' : ''}</td>
        <td style="max-width:340px"><span class="muted">${consText || '—'}</span></td>
        <td>
          ${canEditAgents ? `<button class="btn small" data-act="edit" data-id="${a.id}">Επεξεργασία</button>` : ''}
          ${a.active
            ? `<button class="btn small danger" data-act="deactivate" data-id="${a.id}">Απενεργ/ση</button>`
            : `<button class="btn small" data-act="activate" data-id="${a.id}">Ενεργοποίηση</button>`}
        </td>`;
      tbody.appendChild(tr);
    }
  }

  // ---------- Ενέργειες πίνακα ----------
  document.querySelector('#agentsTable tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;

    if (btn.dataset.act === 'edit') {
      openModal(id);
    } else if (btn.dataset.act === 'deactivate') {
      if (!confirm('Απενεργοποίηση agent; Θα εξαφανιστεί από τις λίστες αλλά το ιστορικό του διατηρείται.')) return;
      const d = await api(`/api/agents/${id}/active`, { method: 'PUT', body: JSON.stringify({ active: 0 }) });
      d.ok ? (toast('Απενεργοποιήθηκε'), loadAgents()) : toast('Σφάλμα: ' + d.error);
    } else if (btn.dataset.act === 'activate') {
      const d = await api(`/api/agents/${id}/active`, { method: 'PUT', body: JSON.stringify({ active: 1 }) });
      d.ok ? (toast('Ενεργοποιήθηκε'), loadAgents()) : toast('Σφάλμα: ' + d.error);
    }
  });

  // ---------- Modal ----------
  function dayCheckboxes(containerId) {
    const c = $(containerId);
    c.innerHTML = '';
    for (let d = 1; d <= 7; d++) {
      const l = document.createElement('label');
      l.innerHTML = `<input type="checkbox" value="${d}"> ${DAY_NAMES[d]}`;
      c.appendChild(l);
    }
  }

  function addConstraintRow(constraint = {}) {
    const row = document.createElement('div');
    row.className = 'constraint-row';
    row.dataset.cid = constraint.id || '';
    row.innerHTML = `
      <textarea placeholder="Περιγραφή κανόνα…">${esc(constraint.description || '')}</textarea>
      <button class="btn small danger" type="button" title="Διαγραφή κανόνα">✕</button>`;
    row.querySelector('button').addEventListener('click', () => row.remove());
    $('fConstraints').appendChild(row);
  }

  async function openModal(id = null) {
    editingId = id;
    $('modalErr').textContent = '';
    $('modalTitle').textContent = id ? 'Επεξεργασία agent' : 'Νέος agent';

    // Skills checkboxes από meta
    const sk = $('fSkills');
    sk.innerHTML = '';
    for (const s of meta.skills) {
      const l = document.createElement('label');
      l.innerHTML = `<input type="checkbox" value="${s.id}"> ${esc(s.name)}`;
      sk.appendChild(l);
    }
    dayCheckboxes('fFixedDays');
    dayCheckboxes('fFixedDaysOff');
    $('fConstraints').innerHTML = '';

    // Καθαρισμός πεδίων
    $('fFullName').value = '';
    $('fCompany').value = '';
    $('fCanNight').value = '';
    $('fFixedStart').value = '';
    $('fFixedEnd').value = '';
    $('fWeekendShift').value = '';
    $('fWorkLocation').value = '';
    $('fIsNew').value = '0';
    $('fNotes').value = '';
    document.querySelectorAll('#fDepartments input').forEach((c) => (c.checked = false));

    if (id) {
      const d = await api('/api/agents/' + id);
      if (!d.ok) return toast('Σφάλμα: ' + d.error);
      const a = d.agent;
      $('fFullName').value = a.full_name;
      $('fCompany').value = a.company || '';
      $('fCanNight').value = a.can_night === null ? '' : String(a.can_night);
      $('fIsNew').value = String(a.is_new);
      $('fFixedStart').value = a.fixed_shift_start || '';
      $('fFixedEnd').value = a.fixed_shift_end === '24:00' ? '' : (a.fixed_shift_end || '');
      if (a.fixed_shift_end === '24:00') $('fFixedEnd').value = '23:59'; // το input time δεν δέχεται 24:00
      $('fWeekendShift').value = a.weekend_shift || '';
      $('fWorkLocation').value = a.work_location || '';
      $('fNotes').value = a.notes || '';
      document.querySelectorAll('#fDepartments input').forEach((c) => (c.checked = a.departments.includes(c.value)));
      document.querySelectorAll('#fSkills input').forEach((c) => (c.checked = a.skills.some((s) => s.id === Number(c.value))));
      document.querySelectorAll('#fFixedDays input').forEach((c) => (c.checked = (a.fixed_days || []).includes(Number(c.value))));
      document.querySelectorAll('#fFixedDaysOff input').forEach((c) => (c.checked = (a.fixed_days_off || []).includes(Number(c.value))));
      for (const c of a.constraints) addConstraintRow(c);
    }

    $('modalBackdrop').style.display = 'flex';
    $('fFullName').focus();
  }

  function closeModal() {
    $('modalBackdrop').style.display = 'none';
  }

  $('addBtn').addEventListener('click', () => openModal(null));
  $('cancelBtn').addEventListener('click', closeModal);
  $('addConstraintBtn').addEventListener('click', () => addConstraintRow());
  $('modalBackdrop').addEventListener('click', (e) => {
    if (e.target === $('modalBackdrop')) closeModal();
  });

  // ---------- Αποθήκευση ----------
  $('saveBtn').addEventListener('click', async () => {
    const checked = (sel) => [...document.querySelectorAll(sel + ' input:checked')].map((c) => c.value);

    // Το input type=time δίνει 23:59 — αποθηκεύουμε 24:00 όπως στο spec
    let fixedEnd = $('fFixedEnd').value;
    if (fixedEnd === '23:59') fixedEnd = '24:00';

    const payload = {
      full_name: $('fFullName').value,
      company: $('fCompany').value || null,
      departments: checked('#fDepartments'),
      can_night: $('fCanNight').value === '' ? null : Number($('fCanNight').value),
      is_new: Number($('fIsNew').value),
      fixed_shift_start: $('fFixedStart').value || null,
      fixed_shift_end: fixedEnd || null,
      fixed_days: checked('#fFixedDays').map(Number),
      fixed_days_off: checked('#fFixedDaysOff').map(Number),
      weekend_shift: $('fWeekendShift').value.trim() || null,
      work_location: $('fWorkLocation').value || null,
      notes: $('fNotes').value.trim() || null,
      skill_ids: checked('#fSkills').map(Number),
      constraints: [...document.querySelectorAll('#fConstraints .constraint-row')].map((row) => ({
        id: row.dataset.cid ? Number(row.dataset.cid) : null,
        description: row.querySelector('textarea').value
      }))
    };

    if (payload.weekend_shift && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(payload.weekend_shift)) {
      $('modalErr').textContent = 'Η βάρδια ΣΚ πρέπει να έχει μορφή HH:MM-HH:MM (π.χ. 16:00-24:00)';
      return;
    }

    const url = editingId ? '/api/agents/' + editingId : '/api/agents';
    const method = editingId ? 'PUT' : 'POST';
    const d = await api(url, { method, body: JSON.stringify(payload) });
    if (d.ok) {
      closeModal();
      toast(editingId ? 'Αποθηκεύτηκε' : 'Δημιουργήθηκε');
      loadAgents();
    } else {
      $('modalErr').textContent = d.error;
    }
  });

  // ---------- Φίλτρα ----------
  let searchTimer;
  $('fltSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadAgents, 300);
  });
  $('fltDept').addEventListener('change', loadAgents);
  $('fltCompany').addEventListener('change', loadAgents);
  $('fltInactive').addEventListener('change', loadAgents);

  // ---------- Εκκίνηση ----------
  (async () => {
    await checkAuth();
    const m = await api('/api/meta');
    if (m.ok) meta = m;
    await loadAgents();
  })();
})();
