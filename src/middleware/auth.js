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
  if (!req.user || req.user.role !== role) return res.status(403).json({ error: "forbidden" });
  next();
};

