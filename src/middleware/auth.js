// Middleware ελέγχου σύνδεσης: όλα τα API εκτός του login απαιτούν session.
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  res.status(401).json({ ok: false, error: 'Απαιτείται σύνδεση' });
}

module.exports = { requireAuth };
