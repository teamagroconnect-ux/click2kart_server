import express from "express";
import mongoose from "mongoose";
import { auth, requireRole } from "../middleware/auth.js";
import Partner from "../models/Partner.js";
import Coupon from "../models/Coupon.js";
import Bill from "../models/Bill.js";
import PartnerPayout from "../models/PartnerPayout.js";
import Customer from "../models/Customer.js";
import { sendPartnerWelcome } from "../lib/mailer.js";

const router = express.Router();

router.get("/", auth, requireRole("admin"), async (req, res) => {
  const items = await Partner.find({}).sort({ createdAt: -1 });
  res.json(items);
});

// Helper function to compute summary for a coupon (same as in partnerRoutes.js)
async function computeSummaryForCoupon(coupon) {
  const code = coupon.code;
  const bills = await Bill.find({ couponCode: code });
  const totalSales = bills.reduce((sum, b) => sum + (b.payable || 0), 0);
  const commissionPercent = Number(coupon.partnerCommissionPercent || 0);
  const totalCommission = (totalSales * commissionPercent) / 100;
  
  // Category breakdown
  const categoryMap = {};
  for (const b of bills) {
    const billCommission = (b.payable * commissionPercent) / 100;
    // Distribute bill commission across its items' categories proportionately
    for (const it of b.items) {
      const cat = it.category || "General";
      const itemWeight = it.lineTotal / (b.total || 1);
      const itemComm = billCommission * itemWeight;
      categoryMap[cat] = (categoryMap[cat] || 0) + itemComm;
    }
  }
  const categoryBreakdown = Object.entries(categoryMap).map(([name, value]) => ({ name, value }));

  const payouts = await PartnerPayout.find({ couponCode: code }).sort({ createdAt: -1 });
  const totalPaid = payouts.reduce((sum, p) => sum + (p.amount || 0), 0);
  const balance = totalCommission - totalPaid;
  return {
    couponId: coupon._id,
    code,
    partnerName: coupon.partnerName || "",
    partnerEmail: coupon.partnerEmail || "",
    partnerPhone: coupon.partnerPhone || "",
    commissionPercent,
    totalSales,
    totalCommission,
    totalPaid,
    balance,
    categoryBreakdown,
    payouts
  };
}

router.get("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  
  const partner = await Partner.findById(req.params.id);
  if (!partner) return res.status(404).json({ error: "not_found" });

  // Get partner coupons
  const coupons = await Coupon.find({ partner: partner._id }).sort({ createdAt: -1 });

  // Get partner referred orders
  const couponCodes = coupons.map(c => c.code);
  const referredOrders = await Bill.find({ couponCode: { $in: couponCodes } }).sort({ createdAt: -1 });

  // Calculate totals
  const totalSales = referredOrders.reduce((sum, o) => sum + (o.payable || 0), 0);
  let totalCommission = 0;
  const couponsWithStats = await Promise.all(coupons.map(async (coupon) => {
    const summary = await computeSummaryForCoupon(coupon);
    totalCommission += summary.totalCommission;
    return {
      ...coupon.toObject(),
      sales: summary.totalSales,
      usageCount: referredOrders.filter(o => o.couponCode === coupon.code).length,
      status: coupon.isActive ? "active" : "inactive"
    };
  }));

  // Get partner payouts
  const payouts = await PartnerPayout.find({ couponCode: { $in: couponCodes } }).sort({ createdAt: -1 });
  const totalPaid = payouts.reduce((sum, p) => sum + (p.amount || 0), 0);

  // Get referred businesses (customers who used partner's invite code)
  const referredBusinesses = await Customer.find({
    "kyc.partnerInviteCode": { $in: couponCodes }
  }).sort({ createdAt: -1 });

  res.json({
    ...partner.toObject(),
    totalSales,
    totalCommission,
    totalPaid,
    balance: totalCommission - totalPaid,
    coupons: couponsWithStats,
    referredOrders,
    payouts,
    referredBusinesses
  });
});

router.post("/", auth, requireRole("admin"), async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name) return res.status(400).json({ error: "missing_name" });
  const doc = await Partner.create({
    name: String(name).trim(),
    email: email ? String(email).trim().toLowerCase() : "",
    phone: phone ? String(phone).trim() : "",
    password: password ? String(password).trim() : undefined,
    isActive: true
  });
  
  // Send welcome email
  try {
    await sendPartnerWelcome(doc);
  } catch (emailErr) {
    console.error("Failed to send welcome email:", emailErr);
  }
  
  res.status(201).json(doc);
});

router.put("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const payload = {};
  if (req.body?.name != null) payload.name = String(req.body.name).trim();
  if (req.body?.email != null) payload.email = String(req.body.email).trim().toLowerCase();
  if (req.body?.phone != null) payload.phone = String(req.body.phone).trim();
  if (req.body?.password !== undefined) payload.password = req.body.password ? String(req.body.password).trim() : undefined;
  if (req.body?.isActive != null) payload.isActive = !!req.body.isActive;
  if (req.body?.isVerified != null) payload.isVerified = !!req.body.isVerified;
  const updated = await Partner.findByIdAndUpdate(req.params.id, payload, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json(updated);
});

router.put("/:id/approve", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const updated = await Partner.findByIdAndUpdate(req.params.id, { isActive: true, isVerified: true }, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json(updated);
});

router.delete("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  await Partner.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

export default router;

