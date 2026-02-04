module.exports = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const userRole = req.user.role.toUpperCase();

    const roles = allowedRoles.map((r) => r.toUpperCase());

    if (!roles.includes(userRole)) {
      return res.status(403).json({ error: "Access denied" });
    }
    next();
  };
};
