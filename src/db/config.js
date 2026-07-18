// Ρυθμίσεις σύνδεσης MySQL/MariaDB.
// - Τοπικά (XAMPP): προεπιλογές root@localhost / programa_vardion.
// - Παραγωγή (Railway/Render/άλλο cloud): διαβάζει είτε ένα ενιαίο URL
//   (DATABASE_URL ή MYSQL_URL, όπως δίνει το Railway), είτε ξεχωριστές
//   μεταβλητές — υποστηρίζονται ΚΑΙ τα ονόματα DB_* (δικά μας) ΚΑΙ MYSQL*
//   (του Railway), ώστε να «κουμπώνει» χωρίς επιπλέον ρύθμιση.
function fromUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '')
  };
}

const url = process.env.DATABASE_URL || process.env.MYSQL_URL;
const base = url
  ? fromUrl(url)
  : {
      host: process.env.DB_HOST || process.env.MYSQLHOST || 'localhost',
      port: Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306),
      user: process.env.DB_USER || process.env.MYSQLUSER || 'root',
      password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '',
      database: process.env.DB_NAME || process.env.MYSQLDATABASE || 'programa_vardion'
    };

module.exports = {
  ...base,
  charset: 'utf8mb4' // ΑΠΑΡΑΙΤΗΤΟ για σωστή αποθήκευση ελληνικών
};
