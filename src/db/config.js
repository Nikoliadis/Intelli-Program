// Ρυθμίσεις σύνδεσης MariaDB (XAMPP local).
// Μπορούν να παρακαμφθούν με μεταβλητές περιβάλλοντος για τη φάση παραγωγής.
module.exports = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'programa_vardion',
  charset: 'utf8mb4' // ΑΠΑΡΑΙΤΗΤΟ για σωστή αποθήκευση ελληνικών
};
