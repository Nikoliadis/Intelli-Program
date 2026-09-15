// Δημιουργία χρήστη με ΤΑ ΙΔΙΑ ΔΙΚΑΙΩΜΑΤΑ με έναν υπάρχοντα χρήστη.
//   node scripts/clone_user.js <νέος-χρήστης> <κωδικός> --like <υπάρχων-χρήστης> [displayName]
//
// Σε αντίθεση με το create_user.js (όπου δηλώνεις χειροκίνητα το
// --no-edit-agents), εδώ τα δικαιώματα ΔΙΑΒΑΖΟΝΤΑΙ από τον χρήστη-πρότυπο
// της ΙΔΙΑΣ βάσης — οπότε βγαίνει σωστό και τοπικά και στο Railway, χωρίς
// να χρειάζεται να ξέρεις εκ των προτέρων τι δικαιώματα έχει.
//
// Τοπικά:   node scripts/clone_user.js mangeloudi 'ΚΩΔΙΚΟΣ' --like xamira
// Railway:  DATABASE_URL="mysql://..." node scripts/clone_user.js mangeloudi 'ΚΩΔΙΚΟΣ' --like xamira
//
// ΠΡΟΣΟΧΗ: βάλε τον κωδικό σε ΜΟΝΑ εισαγωγικά — χαρακτήρες όπως ! και @
// έχουν ειδική σημασία στο shell.
//
// Με --dry-run δείχνει τι θα κάνει χωρίς καμία εγγραφή.
const bcrypt = require('bcryptjs');
const pool = require('../src/db/pool');
const cfg = require('../src/db/config');

// Στήλες δικαιωμάτων που αντιγράφονται (ό,τι υπάρχει από αυτές στη βάση).
// Πρόσθεσε εδώ αν μελλοντικά μπουν κι άλλα δικαιώματα στον πίνακα users.
const PERMISSION_COLUMNS = ['can_edit_agents'];

(async () => {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry-run');
  const likeIdx = argv.indexOf('--like');
  const like = likeIdx >= 0 ? argv[likeIdx + 1] : null;
  const positional = argv.filter((a, i) => !a.startsWith('--') && i !== likeIdx + 1);
  const [username, password, display] = positional;

  if (!username || !password || !like) {
    console.error("Χρήση: node scripts/clone_user.js <νέος-χρήστης> <κωδικός> --like <υπάρχων-χρήστης> [displayName]");
    process.exit(1);
  }

  console.log(`Βάση: ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}${dry ? '   [DRY-RUN — καμία εγγραφή]' : ''}\n`);

  // Ποιες από τις στήλες δικαιωμάτων υπάρχουν όντως σε αυτή τη βάση
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
  );
  const present = new Set(cols.map((x) => x.c));
  const perms = PERMISSION_COLUMNS.filter((c) => present.has(c));

  const [[ref]] = await pool.query(
    `SELECT username, display_name${perms.length ? ', ' + perms.map((c) => '`' + c + '`').join(', ') : ''}
     FROM users WHERE username = ?`,
    [like]
  );
  if (!ref) {
    console.error(`ΣΦΑΛΜΑ: δεν βρέθηκε ο χρήστης-πρότυπο «${like}» σε αυτή τη βάση.`);
    await pool.end();
    process.exit(1);
  }

  console.log(`Πρότυπο: «${ref.username}»`);
  for (const c of perms) console.log(`   ${c} = ${ref[c]}`);
  if (perms.length === 0) console.log('   (η βάση δεν έχει στήλες δικαιωμάτων — όλοι οι χρήστες είναι ισότιμοι)');

  const [[existing]] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
  console.log(`\nΝέος χρήστης: «${username}»${existing ? '  (ΥΠΑΡΧΕΙ ΗΔΗ — θα ενημερωθεί κωδικός/δικαιώματα)' : '  (νέα εγγραφή)'}`);

  if (dry) {
    console.log('\nDRY-RUN: δεν γράφτηκε τίποτα.');
    await pool.end();
    return;
  }

  const hash = bcrypt.hashSync(password, 10);
  const fields = ['username', 'password_hash', 'display_name', ...perms];
  const values = [username, hash, display || username, ...perms.map((c) => ref[c])];
  await pool.query(
    `INSERT INTO users (${fields.map((f) => '`' + f + '`').join(', ')})
     VALUES (${fields.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE ${fields.slice(1).map((f) => '`' + f + '` = VALUES(`' + f + '`)').join(', ')}`,
    values
  );

  // Επαλήθευση: ίδια δικαιώματα με το πρότυπο + ο κωδικός δουλεύει
  const [[made]] = await pool.query(
    `SELECT password_hash${perms.length ? ', ' + perms.map((c) => '`' + c + '`').join(', ') : ''}
     FROM users WHERE username = ?`,
    [username]
  );
  const same = perms.every((c) => made[c] === ref[c]);
  const login = bcrypt.compareSync(password, made.password_hash);
  console.log(`\n${same ? '✓' : '✗'} δικαιώματα ίδια με «${ref.username}»`);
  console.log(`${login ? '✓' : '✗'} ο κωδικός επαληθεύεται`);
  console.log(same && login ? '\nΈτοιμο.' : '\nΚΑΤΙ ΠΗΓΕ ΣΤΡΑΒΑ — έλεγξέ το.');

  await pool.end();
})().catch((e) => { console.error('Σφάλμα:', e.message); process.exit(1); });
