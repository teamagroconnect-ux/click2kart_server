import express from "express";
import Category from "../models/Category.js";
import Coupon from "../models/Coupon.js";
import Bill from "../models/Bill.js";
import PartnerPayout from "../models/PartnerPayout.js";

const router = express.Router();

const toUpper = (s) => (s || "").toString().trim().toUpperCase();

async function computeSummaryForCoupon(coupon) {
  const code = coupon.code;
  const bills = await Bill.find({ couponCode: code });
  const totalSales = bills.reduce((sum, b) => sum + (b.payable || 0), 0);
  const commissionPercent = Number(coupon.partnerCommissionPercent || 0);
  const totalCommission = (totalSales * commissionPercent) / 100;
  
  const categoryMap = {};
  for (const b of bills) {
    const billCommission = (b.payable * commissionPercent) / 100;
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

router.get("/categories", async (req, res) => {
  const items = await Category.find({ isActive: true }).sort({ name: 1 }).select({ name: 1, description: 1 });
  res.json(items);
});

// Partner Summary Portal (Public)
router.post("/partner/summary/:code", async (req, res) => {
  const code = toUpper(req.params.code);
  const { password } = req.body || {};
  
  if (!password) return res.status(400).json({ error: "missing_password" });

  const coupon = await Coupon.findOne({ code, isActive: true });
  if (!coupon) return res.status(404).json({ error: "not_found" });
  
  if (coupon.password && coupon.password !== password) {
    return res.status(401).json({ error: "invalid_password" });
  }
  if (!coupon.partnerName && !coupon.partnerCommissionPercent) {
    return res.status(400).json({ error: "no_partner_configured" });
  }
  
  const summary = await computeSummaryForCoupon(coupon);
  const safePayouts = summary.payouts.map((p) => ({
    createdAt: p.createdAt,
    amount: p.amount,
    method: p.method,
    utr: p.utr,
    razorpayPaymentId: p.razorpayPaymentId,
    notes: p.notes
  }));
  
  res.json({
    code: summary.code,
    partnerName: summary.partnerName,
    partnerEmail: summary.partnerEmail,
    partnerPhone: summary.partnerPhone,
    commissionPercent: summary.commissionPercent,
    totalSales: summary.totalSales,
    totalCommission: summary.totalCommission,
    totalPaid: summary.totalPaid,
    balance: summary.balance,
    categoryBreakdown: summary.categoryBreakdown,
    payouts: safePayouts
  });
});

export default router;

