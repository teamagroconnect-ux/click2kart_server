import express from "express";
import { auth, requireRole } from "../middleware/auth.js";
import Customer from "../models/Customer.js";

const router = express.Router();

router.get("/me", auth, async (req, res) => {
  if (req.user.role === "admin") {
    const Admin = (await import("../models/Admin.js")).default;
    const admin = await Admin.findById(req.user.id).select("name email");
    if (!admin) return res.status(404).json({ error: "not_found" });
    return res.json({
      id: admin._id.toString(),
      name: admin.name,
      email: admin.email,
      role: "admin"
    });
  }

  const user = await Customer.findById(req.user.id).select("name email phone address isKycComplete kyc");
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({
    id: user._id.toString(),
    name: user.name,
    email: user.email || "",
    phone: user.phone,
    defaultAddress: user.address || "",
    isKycComplete: !!user.isKycComplete,
    kyc: user.kyc || {},
    role: "customer"
  });
});

router.put("/kyc", auth, requireRole("customer"), async (req, res) => {
  const payload = req.body || {};
  const user = await Customer.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "not_found" });

  const allowed = ["businessName", "gstin", "pan", "addressLine1", "addressLine2", "city", "district", "state", "pincode", "profilePicture"];
  const restricted = ["businessName", "gstin", "pan"];
  
  const kyc = { ...(user.kyc || {}) };
  
  for (const k of allowed) {
    if (typeof payload[k] === "string") {
      const value = payload[k].trim();
      // Only allow updating if it was empty or if it's not a restricted field
      if (!restricted.includes(k) || !kyc[k]) {
        kyc[k] = value;
      }
    }
  }

  const requiredFilled = (kyc.businessName && kyc.gstin && kyc.pan && kyc.addressLine1 && kyc.city && kyc.district && kyc.state && kyc.pincode);
  
  user.kyc = kyc;
  user.isKycComplete = !!requiredFilled;
  await user.save();

  res.json({ isKycComplete: user.isKycComplete, kyc: user.kyc });
});

router.put("/profile", auth, requireRole("customer"), async (req, res) => {
  const { address, name, phone } = req.body;
  const user = await Customer.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "not_found" });

  if (address !== undefined) user.address = address;
  if (typeof name === "string") user.name = name.trim();
  if (typeof phone === "string") user.phone = phone.trim();

  await user.save();
  res.json({ success: true });
});

router.put("/change-password", auth, requireRole("customer"), async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ error: "all_fields_required" });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: "passwords_do_not_match" });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: "password_too_short" });
  }

  const user = await Customer.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "not_found" });

  if (user.password) {
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({ error: "incorrect_password" });
    }
  }

  user.password = newPassword;
  await user.save();

  res.json({ success: true });
});

export default router;
