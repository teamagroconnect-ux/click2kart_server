import express from "express";
import jwt from "jsonwebtoken";
import Admin from "../models/Admin.js";
import Customer from "../models/Customer.js";
import OTP from "../models/OTP.js";
import { sendOTP } from "../lib/mailer.js";

const router = express.Router();

// ADMIN LOGIN
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
    { id: admin._id.toString(), role: "admin", email: admin.email },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
  res.json({
    token,
    admin: { id: admin._id.toString(), name: admin.name, email: admin.email, role: "admin" }
  });
});

// CUSTOMER SIGNUP - Step 1: Send OTP
router.post("/customer/signup", async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || !email || !phone || !password) return res.status(400).json({ error: "missing_fields" });

  const exists = await Customer.findOne({ $or: [{ email: email.toLowerCase() }, { phone }] });
  if (exists) return res.status(400).json({ error: "user_already_exists" });

  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

  await OTP.findOneAndUpdate(
    { email: email.toLowerCase(), purpose: "SIGNUP" },
    { otp, expiresAt, metadata: { name, phone, password } },
    { upsert: true }
  );

  try {
    await sendOTP(email, otp);
    res.json({ message: "otp_sent" });
  } catch (err) {
    res.status(500).json({ error: "failed_to_send_email" });
  }
});

// CUSTOMER SIGNUP - Step 2: Verify OTP
router.post("/customer/verify-otp", async (req, res) => {
  const { email, otp } = req.body || {};
  if (!email || !otp) return res.status(400).json({ error: "missing_fields" });

  const record = await OTP.findOne({ email: email.toLowerCase(), otp, purpose: "SIGNUP" });
  if (!record) return res.status(400).json({ error: "invalid_otp" });

  const { name, phone, password } = record.metadata;
  const customer = await Customer.create({
    name,
    email: email.toLowerCase(),
    phone,
    password,
    isVerified: true,
    isActive: false
  });

  await OTP.deleteOne({ _id: record._id });

  res.json({ message: "application_submitted" });
});

// CUSTOMER LOGIN
router.post("/customer/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "missing_fields" });

  const user = await Customer.findOne({ email: email.toLowerCase().trim(), isActive: true });
  if (!user) return res.status(401).json({ error: "invalid_credentials" });

  const ok = await user.comparePassword(password);
  if (!ok) return res.status(401).json({ error: "invalid_credentials" });

  const token = jwt.sign(
    { id: user._id.toString(), role: "customer", email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );

  res.json({
    token,
    user: { id: user._id.toString(), name: user.name, email: user.email, role: "customer" }
  });
});

// FORGOT PASSWORD - Step 1: Send OTP
router.post("/customer/forgot-password", async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "missing_email" });

  const user = await Customer.findOne({ email: email.toLowerCase(), isActive: true });
  if (!user) return res.status(404).json({ error: "user_not_found" });

  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await OTP.findOneAndUpdate(
    { email: email.toLowerCase(), purpose: "FORGOT_PASSWORD" },
    { otp, expiresAt },
    { upsert: true }
  );

  try {
    await sendOTP(email, otp);
    res.json({ message: "otp_sent" });
  } catch (err) {
    res.status(500).json({ error: "failed_to_send_email" });
  }
});

// FORGOT PASSWORD - Step 2: Reset
router.post("/customer/reset-password", async (req, res) => {
  const { email, otp, newPassword } = req.body || {};
  if (!email || !otp || !newPassword) return res.status(400).json({ error: "missing_fields" });

  const record = await OTP.findOne({ email: email.toLowerCase(), otp, purpose: "FORGOT_PASSWORD" });
  if (!record) return res.status(400).json({ error: "invalid_otp" });

  const user = await Customer.findOne({ email: email.toLowerCase() });
  if (!user) return res.status(404).json({ error: "user_not_found" });

  user.password = newPassword;
  await user.save();

  await OTP.deleteOne({ _id: record._id });

  res.json({ message: "password_reset_success" });
});

export default router;
