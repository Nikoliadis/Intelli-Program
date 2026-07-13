// Οθόνη «Έλεγχος Excel»: ανεβάζεις ένα εβδομαδιαίο Excel που έχει ήδη βγει,
// και βλέπεις ΑΝΑ AGENT τι διάβασε το σύστημα + με πόσες συνεχόμενες μέρες
// μπαίνει στην επόμενη εβδομάδα (Κ10). Preview ΧΩΡΙΣ αποθήκευση· μετά τον
// έλεγχο, «Αποθήκευση» ώστε το SOS να το υπολογίζει στα σύνορα. (15/07/2026)
(() => {
  const $ = (id) => document.getElementById(id);
  const DAY_GR = ['Δε', 'Τρ', 'Τε', 'Πε', 'Πα', 'Σα', 'Κυ'];

  async function api(url, options = {}) {
    const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
    if (r.status === 401) { location.href = '/login.html'; throw new Error('auth'); }
    return r.json();
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2800);
  }
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // Αρχείο → base64 (ίδιο chunking με schedule.js για μεγάλα αρχεία)
  async function fileToBase64(file) {
    const buf = await file.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  let lastPreview = null; // {weekStart, fileBase64} για την Αποθήκευση

  function showErr(msg) {
    const el = $('impErr');
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }

  function render(d) {
    // Ασυνήθιστα αναγνωρισμένα ονόματα
    const un = $('impUnmatched');
    if (d.unmatchedNames && d.unmatchedNames.length) {
      un.style.display = 'block';
      un.innerHTML = '⚠ Δεν αναγνωρίστηκαν κάποια κείμενα ως agents (ελέγξ’ τα): '
        + d.unmatchedNames.map(esc).join(', ');
    } else {
      un.style.display = 'none';
    }

    // Περίληψη
    const inFile = d.rows.filter((r) => r.inFile).length;
    $('impSummary').textContent =
      `Εβδομάδα ${d.weekStart} — ${d.totalShifts} βάρδιες, ${inFile} agents με εργασία στο αρχείο.`;

    // Κεφαλίδα πίνακα
    const head = $('impHead');
    head.innerHTML = '<th style="text-align:left">Agent</th>'
      + d.dates.map((dt, i) => {
          const wknd = i >= 5 ? ' class="imp-weekend"' : '';
          return `<th${wknd} title="${esc(dt)}">${DAY_GR[i]}</th>`;
        }).join('')
      + '<th title="Σύνολο εργάσιμων ημερών στο αρχείο">Εργ.</th>'
      + '<th title="Συνεχόμενες μέρες που κλείνει η Κυριακή — μπαίνουν στην επόμενη εβδομάδα (Κ10)">Σερί→</th>';

    // Σειρές: πρώτα όσοι έχουν εργασία, μετά οι υπόλοιποι
    const rows = [...d.rows].sort((a, b) => (b.inFile - a.inFile) || a.name.localeCompare(b.name, 'el'));
    const tbody = $('impTable').querySelector('tbody');
    tbody.innerHTML = rows.map((r) => {
      // «Καμπανάκι»: μπαίνει με ≥5 σερί (θα χρειαστεί ρεπό Δευτέρα) ή δεν είναι στο αρχείο
      const warnStreak = r.streakInto >= 5;
      const cls = warnStreak ? ' class="imp-warn"' : '';
      const cells = r.days.map((v, i) => {
        const wknd = i >= 5 ? ' imp-weekend' : '';
        return `<td class="imp-cell${wknd}">${v ? esc(v) : '<span class="imp-off">ρεπό</span>'}</td>`;
      }).join('');
      const wBadge = `<span class="imp-badge ${r.workDays === 5 ? 'ok' : (r.inFile ? 'bad' : '')}">${r.workDays}</span>`;
      const sBadge = r.streakInto
        ? `<span class="imp-badge ${warnStreak ? 'bad' : 'streak'}" title="${warnStreak ? 'Χρειάζεται ρεπό στην αρχή της επόμενης εβδομάδας' : ''}">${r.streakInto}${r.pendingNightRest ? ' +αν.' : ''}</span>`
        : '<span class="imp-off">—</span>';
      return `<tr${cls}><td style="text-align:left">${esc(r.name)}</td>${cells}<td class="imp-cell">${wBadge}</td><td class="imp-cell">${sBadge}</td></tr>`;
    }).join('');
    $('impTable').style.display = 'table';
  }

  async function doPreview() {
    showErr('');
    const weekStart = $('impWeekStart').value;
    const file = $('impFile').files[0];
    if (!weekStart) return showErr('Διάλεξε τη Δευτέρα της εβδομάδας του αρχείου.');
    if (!file) return showErr('Διάλεξε αρχείο Excel (.xlsx).');

    $('impPreviewBtn').disabled = true;
    $('impPreviewBtn').textContent = '⏳ Ανάλυση…';
    try {
      const fileBase64 = await fileToBase64(file);
      const d = await api('/api/import/preview', {
        method: 'POST',
        body: JSON.stringify({ weekStart, fileBase64 })
      });
      if (!d.ok) { showErr('Σφάλμα: ' + d.error); $('impSaveBtn').disabled = true; return; }
      render(d);
      lastPreview = { weekStart, fileBase64 };
      $('impSaveBtn').disabled = false;
    } catch (e) {
      showErr('Σφάλμα ανάλυσης: ' + e.message);
    } finally {
      $('impPreviewBtn').disabled = false;
      $('impPreviewBtn').textContent = '🔍 Έλεγχος (χωρίς αποθήκευση)';
    }
  }

  async function doSave() {
    if (!lastPreview) return;
    if (!confirm(`Αποθήκευση της εβδομάδας ${lastPreview.weekStart} ως εισηγμένης; Θα χρησιμοποιείται από το SOS στα σύνορα.`)) return;
    $('impSaveBtn').disabled = true;
    $('impSaveBtn').textContent = '⏳ Αποθήκευση…';
    try {
      const d = await api('/api/import/week', {
        method: 'POST',
        body: JSON.stringify(lastPreview)
      });
      if (!d.ok) { showErr('Σφάλμα αποθήκευσης: ' + d.error); return; }
      toast(`Αποθηκεύτηκε: ${d.imported} βάρδιες για ${d.weekStart}.`);
    } catch (e) {
      showErr('Σφάλμα αποθήκευσης: ' + e.message);
    } finally {
      $('impSaveBtn').disabled = false;
      $('impSaveBtn').textContent = '💾 Αποθήκευση';
    }
  }

  async function init() {
    const me = await api('/api/me').catch(() => null);
    if (!me || !me.ok) { location.href = '/login.html'; return; }
    $('userName').textContent = me.displayName;

    $('logoutBtn').addEventListener('click', async () => {
      await api('/api/logout', { method: 'POST' });
      location.href = '/login.html';
    });
    $('impPreviewBtn').addEventListener('click', doPreview);
    $('impSaveBtn').addEventListener('click', doSave);
    // Νέο αρχείο → ακύρωσε την προηγούμενη «Αποθήκευση»
    $('impFile').addEventListener('change', () => { $('impSaveBtn').disabled = true; lastPreview = null; });
  }

  init();
})();
