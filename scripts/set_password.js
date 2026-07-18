// Αλλαγή κωδικού χρήστη (για ασφαλές deployment — φύγε από το admin/admin).
// Τοπικά:   node scripts/set_password.js admin <νέος-κωδικός>
// Στο cloud: τρέξε το ίδιο με τις env vars της βάσης παραγωγής ρυθμισμένες.
const bcrypt = require('bcryptjs');
const pool = require('../src/db/pool');

(async () => {
  const [, , username, password] = process.argv;
  if (!username || !password) {
    console.error('Χρήση: node scripts/set_password.js <username> <νέος-κωδικός>');
    process.exit(1);
  }
  const hash = bcrypt.hashSync(password, 10);
  const [r] = await pool.query('UPDATE users SET password_hash = ? WHERE username = ?', [hash, username]);
  console.log(
    r.affectedRows
      ? `OK: άλλαξε ο κωδικός του χρήστη «${username}».`
      : `Δεν βρέθηκε χρήστης «${username}».`
  );
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
