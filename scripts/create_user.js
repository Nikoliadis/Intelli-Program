// Δημιουργία/ενημέρωση χρήστη εφαρμογής.
//   node scripts/create_user.js <username> <password> [displayName] [--no-edit-agents]
// --no-edit-agents: ο χρήστης ΔΕΝ θα μπορεί να πατά «Επεξεργασία» σε agent.
// Τρέχει τοπικά (XAMPP) ή στο cloud (με DATABASE_URL της βάσης παραγωγής).
const bcrypt = require('bcryptjs');
const pool = require('../src/db/pool');

(async () => {
  const raw = process.argv.slice(2);
  const noEdit = raw.includes('--no-edit-agents');
  const [username, password, display] = raw.filter((a) => !a.startsWith('--'));
  if (!username || !password) {
    console.error('Χρήση: node scripts/create_user.js <username> <password> [displayName] [--no-edit-agents]');
    process.exit(1);
  }

  // Βεβαιώσου ότι υπάρχει η στήλη δικαιώματος (idempotent)
  try {
    await pool.query('ALTER TABLE users ADD COLUMN can_edit_agents TINYINT NOT NULL DEFAULT 1');
    console.log('OK: προστέθηκε στήλη can_edit_agents.');
  } catch (e) {
    if (!/Duplicate column|exists/i.test(e.message)) throw e;
  }

  const hash = bcrypt.hashSync(password, 10);
  const canEdit = noEdit ? 0 : 1;
  await pool.query(
    `INSERT INTO users (username, password_hash, display_name, can_edit_agents)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       password_hash = VALUES(password_hash),
       display_name = VALUES(display_name),
       can_edit_agents = VALUES(can_edit_agents)`,
    [username, hash, display || username, canEdit]
  );
  console.log(`OK: χρήστης «${username}» (can_edit_agents=${canEdit}).`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
