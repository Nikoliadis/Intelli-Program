// Οθόνη σύνδεσης. Σε εξωτερικό αρχείο (όχι inline) ώστε να ισχύει αυστηρό
// Content-Security-Policy χωρίς 'unsafe-inline' για scripts (18/07/2026).
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value
      })
    });
    if (r.status === 429) {
      err.textContent = 'Πολλές αποτυχημένες προσπάθειες. Δοκίμασε ξανά σε λίγα λεπτά.';
      return;
    }
    const d = await r.json();
    if (d.ok) {
      location.href = '/';
    } else {
      err.textContent = d.error || 'Σφάλμα σύνδεσης';
    }
  } catch (ex) {
    err.textContent = 'Δεν απαντά ο server';
  }
});
