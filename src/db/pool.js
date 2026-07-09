// Κοινό connection pool για όλη την εφαρμογή.
const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
  host: config.host,
  port: config.port,
  user: config.user,
  password: config.password,
  database: config.database,
  charset: 'utf8mb4_unicode_ci',
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  // Οι ημερομηνίες (DATE) επιστρέφουν ως string 'YYYY-MM-DD' — αποφεύγουμε
  // προβλήματα ζώνης ώρας στους υπολογισμούς εβδομάδων.
  dateStrings: true
});

module.exports = pool;
