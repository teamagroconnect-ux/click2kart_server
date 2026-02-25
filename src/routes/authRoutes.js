import express from "express";
import jwt from "jsonwebtoken";
import Admin from "../models/Admin.js";

const router = express.Router();

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "missing_fields" });
  const admin = await Admin.findOne({ email: email.toLowerCase().trim(), isActive: true });
  if (!admin) return res.status(401).json({ error: "invalid_credentials" });
  const ok = await admin.comparePassword(password);
  if (!ok) return res.status(401).json({ error: "invalid_credentials" });
  admin.lastLogin = new Date();
  await admin.save();
  const token = jwt.sign(
    { id: admin._id.toString(), role: admin.role, email: admin.email },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
  res.json({
    token,
    admin: { id: admin._id.toString(), name: admin.name, email: admin.email, role: admin.role }
  });
});

export default router;

