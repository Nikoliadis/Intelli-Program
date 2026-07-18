// Migrations: δημιουργία βάσης και όλων των πινάκων της ενότητας 6 του spec.
// Εκτελείται με: npm run migrate  (ασφαλές να ξανατρέξει — CREATE IF NOT EXISTS)
const mysql = require('mysql2/promise');
const config = require('./config');

async function migrate() {
  // Πρώτα σύνδεση ΧΩΡΙΣ database για να δημιουργηθεί αν δεν υπάρχει
  const conn = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    charset: 'utf8mb4_unicode_ci'
  });

  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.database}\`
     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.changeUser({ database: config.database });

  const tables = [
    // Χρήστες εφαρμογής (προϊστάμενοι) για login
    `CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(100) NOT NULL,
      display_name VARCHAR(100),
      can_edit_agents TINYINT NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // Ρόλοι/γραμμές με χρώμα ARGB για το Excel (επεξεργάσιμοι από Ρυθμίσεις)
    `CREATE TABLE IF NOT EXISTS roles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      color_argb CHAR(8) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // Δεξιότητες ανά project (EUROBANK, ΑΠΕΔ, ALPHA, INTERNATIONAL, ΛΟΙΠΑ, ΗΡΩΝ, ΠΕΙΡΑΙΩΣ)
    `CREATE TABLE IF NOT EXISTS skills (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(50) NOT NULL UNIQUE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // Agents — active=0 σημαίνει αποχώρηση (soft delete, ΠΟΤΕ DELETE)
    `CREATE TABLE IF NOT EXISTS agents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      full_name VARCHAR(120) NOT NULL,
      company VARCHAR(20),
      departments JSON NOT NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      can_night TINYINT(1) NULL,
      is_new TINYINT(1) NOT NULL DEFAULT 0,
      fixed_shift_start VARCHAR(5) NULL,
      fixed_shift_end VARCHAR(5) NULL,
      fixed_days JSON NULL,
      fixed_days_off JSON NULL,
      weekend_shift VARCHAR(11) NULL,
      work_location VARCHAR(10) NULL,
      notes TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // Ποιες δεξιότητες έχει κάθε agent (γενίκευση του agent_roles του spec)
    `CREATE TABLE IF NOT EXISTS agent_skills (
      agent_id INT NOT NULL,
      skill_id INT NOT NULL,
      PRIMARY KEY (agent_id, skill_id),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // Ειδικοί κανόνες ανά agent (γενίκευση κανόνα Νικολιάδη — Κ3)
    `CREATE TABLE IF NOT EXISTS agent_constraints (
      id INT AUTO_INCREMENT PRIMARY KEY,
      agent_id INT NOT NULL,
      day_of_week TINYINT NULL,
      allowed_shifts JSON NULL,
      required_shift VARCHAR(11) NULL,
      description TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // Απαιτήσεις κάλυψης ανά βάρδια (ενότητα 4 — επεξεργάσιμες από Ρυθμίσεις).
    // Δείχνουν σε skill + τμήμα (π.χ. 'Verification & call Eurobank' =
    // department 'verification' + skill EUROBANK). role_id = προτεινόμενο χρώμα.
    `CREATE TABLE IF NOT EXISTS shift_requirements (
      id INT AUTO_INCREMENT PRIMARY KEY,
      day_type ENUM('weekday','weekend') NOT NULL,
      start_time VARCHAR(5) NOT NULL,
      end_time VARCHAR(5) NOT NULL,
      skill_id INT NULL,
      department VARCHAR(30) NULL,
      period VARCHAR(10) NULL,
      headcount INT NOT NULL,
      label VARCHAR(100),
      role_id INT NULL,
      FOREIGN KEY (skill_id) REFERENCES skills(id),
      FOREIGN KEY (role_id) REFERENCES roles(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // Επιλεξιμότητα ειδικών βαρδιών (π.χ. 19:00-03:00) με όρια & τοποθεσία (Κ9).
    // Γενικός μηχανισμός — μπορεί να οριστεί λίστα και για άλλες βάρδιες.
    `CREATE TABLE IF NOT EXISTS shift_eligibility (
      id INT AUTO_INCREMENT PRIMARY KEY,
      agent_id INT NOT NULL,
      shift_start VARCHAR(5) NOT NULL,
      shift_end VARCHAR(5) NOT NULL,
      max_per_week INT NOT NULL,
      location VARCHAR(10) NOT NULL,
      not_alone TINYINT(1) NOT NULL DEFAULT 0,
      notes TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // Άδειες / αιτήματα ρεπό / ασθένειες ανά ημερομηνία (Κ6)
    `CREATE TABLE IF NOT EXISTS time_off (
      id INT AUTO_INCREMENT PRIMARY KEY,
      agent_id INT NOT NULL,
      date DATE NOT NULL,
      type ENUM('repo_request','leave','sick') NOT NULL,
      notes TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      INDEX idx_time_off_date (date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // Παραγόμενα προγράμματα ανά εβδομάδα (ιστορικό + μετρητές δικαιοσύνης)
    `CREATE TABLE IF NOT EXISTS schedules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      week_start DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      data LONGTEXT NOT NULL,
      INDEX idx_schedules_week (week_start)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // Αναθέσεις βαρδιών. Το color_argb είναι το ΤΕΛΙΚΟ χρώμα του κελιού —
    // ο generator μόνο προτείνει, ο προϊστάμενος το αλλάζει ελεύθερα.
    `CREATE TABLE IF NOT EXISTS assignments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      schedule_id INT NOT NULL,
      agent_id INT NOT NULL,
      date DATE NOT NULL,
      start_time VARCHAR(5) NOT NULL,
      end_time VARCHAR(5) NOT NULL,
      skill_id INT NULL,
      role_id INT NULL,
      color_argb CHAR(8) NULL,
      label VARCHAR(50) NULL,
      is_manual_edit TINYINT(1) NOT NULL DEFAULT 0,
      FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id),
      FOREIGN KEY (skill_id) REFERENCES skills(id),
      FOREIGN KEY (role_id) REFERENCES roles(id),
      INDEX idx_assignments_date (date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  ];

  for (const sql of tables) {
    await conn.query(sql);
  }

  await conn.end();
  console.log(`OK: βάση "${config.database}" και ${tables.length} πίνακες έτοιμοι.`);
}

migrate().catch((err) => {
  console.error('Σφάλμα migration:', err.message);
  process.exit(1);
});
