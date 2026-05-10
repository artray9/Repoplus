const jwt = require('jsonwebtoken');

const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase();

function isSuperAdmin(email) {
  if (!SUPER_ADMIN_EMAIL) return false;
  return SUPER_ADMIN_EMAIL.split(',').map(e => e.trim()).includes((email || '').toLowerCase());
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Токен не передан' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    // Если email суперадмина — повышаем роль
    if (isSuperAdmin(decoded.email)) decoded.role = 'superadmin';
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Невалидный или истёкший токен' });
  }
}

function requireAdmin(req, res, next) {
  if (!['admin', 'superadmin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Только для администратора' });
  }
  next();
}

module.exports = { authMiddleware, requireAdmin };
