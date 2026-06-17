import express from "express";
import { auth, requireRole } from "../middleware/auth.js";
import Coupon from "../models/Coupon.js";
import Bill from "../models/Bill.js";
import PartnerPayout from "../models/PartnerPayout.js";
import Partner from "../models/Partner.js";
import Customer from "../models/Customer.js";

const router = express.Router();

const toUpper = (s) => (s || "").toString().trim().toUpperCase();

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

// Admin: list all partner coupons with aggregates
router.get("/", auth, requireRole("admin"), async (req, res) => {
  const coupons = await Coupon.find({
    $or: [
      { partnerName: { $ne: "" } },
      { partnerCommissionPercent: { $gt: 0 } }
    ]
  }).sort({ createdAt: -1 });
  const summaries = await Promise.all(coupons.map((c) => computeSummaryForCoupon(c)));
  res.json(summaries);
});

// Admin: record a payout against a partner's coupon
router.post("/:code/payout", auth, requireRole("admin"), async (req, res) => {
  const code = toUpper(req.params.code);
  const { amount, method, utr, razorpayPaymentId, notes } = req.body || {};
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ error: "invalid_amount" });
  }
  const coupon = await Coupon.findOne({ code, isActive: true });
  if (!coupon) return res.status(404).json({ error: "not_found" });
  const payout = await PartnerPayout.create({
    coupon: coupon._id,
    couponCode: coupon.code,
    amount: numericAmount,
    method: method === "RAZORPAY" ? "RAZORPAY" : "MANUAL",
    utr: utr || "",
    razorpayPaymentId: razorpayPaymentId || "",
    notes: notes || ""
  });
  const summary = await computeSummaryForCoupon(coupon);
  res.status(201).json({ payout, summary });
});

// Partner: Get own profile and dashboard data
router.get("/me", auth, requireRole("partner"), async (req, res) => {
  const partner = await Partner.findById(req.user.id);
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
    "kyc.partnerInviteCode": { $in: coupons.map(c => c.code) }
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

// Partner: Update own profile
router.put("/profile", auth, requireRole("partner"), async (req, res) => {
  const partner = await Partner.findById(req.user.id);
  if (!partner) return res.status(404).json({ error: "not_found" });

  const { name, phone, bloodGroup, address, city, district, state, pincode, bankAccount, profilePicture } = req.body || {};
  const update = {};

  if (name != null) update.name = String(name).trim();
  if (phone != null) update.phone = String(phone).trim();
  if (bloodGroup != null) update.bloodGroup = String(bloodGroup).trim().toUpperCase();
  if (address != null) update.address = String(address).trim();
  if (city != null) update.city = String(city).trim();
  if (district != null) update.district = String(district).trim();
  if (state != null) update.state = String(state).trim();
  if (pincode != null) update.pincode = String(pincode).trim();
  if (bankAccount != null) update.bankAccount = bankAccount;
  if (profilePicture != null) update.profilePicture = String(profilePicture).trim();

  const updated = await Partner.findByIdAndUpdate(req.user.id, update, { new: true });
  res.json(updated);
});

// Partner: Change password
router.put("/change-password", auth, requireRole("partner"), async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ error: "missing_fields" });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: "passwords_do_not_match" });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: "password_too_short" });
  }

  const partner = await Partner.findById(req.user.id);
  if (!partner) return res.status(404).json({ error: "not_found" });

  if (partner.password) {
    const isValid = await partner.comparePassword(currentPassword);
    if (!isValid) return res.status(401).json({ error: "invalid_password" });
  }

  partner.password = newPassword;
  await partner.save();
  res.json({ success: true });
});

export default router;

