import jwt from "jsonwebtoken";

export const auth = (req, res, next) => {
  let token = "";
  const header = req.headers.authorization || "";
  const [type, authToken] = header.split(" ");
  if (type === "Bearer" && authToken) {
    token = authToken;
  } else if (req.query.token) {
    token = req.query.token;
  }

  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
};

export const requireRole = (role) => (req, res, next) => {
  if (!req.user) return res.status(403).json({ error: "forbidden" });
  
  const userRole = req.user.role;
  
  // Admin bypass: Admin can do anything
  if (userRole === "admin") return next();
  
  // If explicitly looking for staff role
  if (role === "staff" && userRole === "staff") return next();
  
  // If explicitly looking for customer role
  if (role === "customer" && userRole === "customer") return next();

  // If role is admin and user is staff, they are forbidden (unless they have specific permissions, 
  // but those are handled at the route level usually or via a separate permission check middleware)
  if (userRole !== role) return res.status(403).json({ error: "forbidden" });
  
  next();
};

export const requirePermission = (permission) => (req, res, next) => {
  if (!req.user) return res.status(403).json({ error: "forbidden" });
  if (req.user.role === "admin") return next();
  
  if (req.user.role === "staff" && req.user.permissions?.includes(permission)) {
    return next();
  }
  
  return res.status(403).json({ error: "insufficient_permissions" });
};

