import express from "express";
import { auth, requireRole } from "../middleware/auth.js";
import Customer from "../models/Customer.js";

const router = express.Router();

router.get("/me", auth, requireRole("customer"), async (req, res) => {
  const user = await Customer.findById(req.user.id).select("name email phone address isKycComplete kyc");
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({
    id: user._id.toString(),
    name: user.name,
    email: user.email || "",
    phone: user.phone,
    defaultAddress: user.address || "",
    isKycComplete: !!user.isKycComplete,
    kyc: user.kyc || {}
  });
});

router.put("/kyc", auth, requireRole("customer"), async (req, res) => {
  const payload = req.body || {};
  const allowed = ["businessName", "gstin", "pan", "addressLine1", "addressLine2", "city", "state", "pincode"];
  const kyc = {};
  for (const k of allowed) if (typeof payload[k] === "string") kyc[k] = payload[k].trim();
  const requiredFilled = (kyc.businessName && kyc.gstin && kyc.pan && kyc.addressLine1 && kyc.city && kyc.state && kyc.pincode);
  const updated = await Customer.findByIdAndUpdate(
    req.user.id,
    { kyc: { ...(kyc || {}) }, isKycComplete: !!requiredFilled },
    { new: true }
  ).select("name email phone isKycComplete kyc");
  res.json({ isKycComplete: updated.isKycComplete, kyc: updated.kyc });
});

export default router;
