import express from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import Category from "../models/Category.js";
import Brand from "../models/Brand.js";
import Coupon from "../models/Coupon.js";
import Bill from "../models/Bill.js";
import PartnerPayout from "../models/PartnerPayout.js";
import Partner from "../models/Partner.js";
import OTP from "../models/OTP.js";
import { sendOTP, sendEmail } from "../lib/mailer.js";
import { getOrSetCache, getCacheVersion, bumpCacheVersion } from "../lib/redis.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = express.Router();

const toUpper = (s) => (s || "").toString().trim().toUpperCase();

const validateEmailFormat = (email) => {
  return String(email)
    .toLowerCase()
    .match(
      /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
    );
};

async function computeSummaryForPartner(partner) {
  // Find all coupons linked by partner's email OR name
  const coupons = await Coupon.find({ 
    $or: [
      { partnerEmail: partner.email },
      { partner: partner._id },
      { partnerName: partner.name }
    ],
    isActive: true 
  });
  const allCodes = coupons.map(c => c.code);
  
  const bills = await Bill.find({ couponCode: { $in: allCodes } }).sort({ createdAt: -1 });
  
  const totalSales = bills.reduce((sum, b) => sum + (b.payable || 0), 0);
  
  // Safe bills list for partner (only masked phone and amount)
  const safeBills = bills.map(b => ({
    createdAt: b.createdAt,
    customerPhone: b.customerPhone ? b.customerPhone.slice(0, 2) + "****" + b.customerPhone.slice(-4) : "****",
    payable: b.payable,
    couponCode: b.couponCode
  }));

  const payouts = await PartnerPayout.find({ couponCode: { $in: allCodes } }).sort({ createdAt: -1 });
  const totalPaid = payouts.reduce((sum, p) => sum + (p.amount || 0), 0);

  // Aggregated commission calculation
  let totalCommission = 0;
  for (const c of coupons) {
    const couponSales = bills.filter(b => b.couponCode === c.code).reduce((sum, b) => sum + (b.payable || 0), 0);
    totalCommission += (couponSales * (Number(c.partnerCommissionPercent) || 0)) / 100;
  }

  const balance = totalCommission - totalPaid;

  const couponStats = coupons.map(c => {
    const couponBills = bills.filter(b => b.couponCode === c.code);
    const sales = couponBills.reduce((sum, b) => sum + (b.payable || 0), 0);
    const commission = (sales * (Number(c.partnerCommissionPercent) || 0)) / 100;
    return {
      code: c.code,
      sales,
      commission,
      commissionPercent: c.partnerCommissionPercent
    };
  });

  return {
    partnerName: partner.name,
    partnerEmail: partner.email,
    partnerPhone: partner.phone,
    totalSales,
    totalCommission,
    totalPaid,
    balance,
    coupons: couponStats,
    payouts,
    bills: safeBills
  };
}

router.get("/categories", async (req, res) => {
  const items = await getOrSetCache("categories:all", async () => {
    return await Category.find({ isActive: true }).sort({ name: 1 }).select({ name: 1, description: 1 });
  }, 86400); // 24 hours
  res.json(items);
});

router.get("/brands", async (req, res) => {
  const active = req.query.active;
  const filter = {};
  if (active === "true") filter.isActive = true;
  if (active === "false") filter.isActive = false;
  const items = await getOrSetCache(`brands:all:${active || "all"}`, async () => {
    return await Brand.find(filter).sort({ name: 1 });
  }, 86400); // 24 hours
  res.json(items);
});

// Public: Get partner details by ID for verification
router.get("/partner/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ error: "invalid_id" });
  }
  const partner = await Partner.findById(req.params.id).select({
    // Don't send sensitive data
    password: 0,
    otp: 0,
    otpExpiry: 0,
    bankAccount: 0
  });
  if (!partner) {
    return res.status(404).json({ error: "partner_not_found" });
  }
  res.json(partner);
});

// Send OTP for Partner Login (via Email)
router.post("/partner/send-otp", rateLimit("partner-send-otp", 3, 600), async (req, res) => {
  const email = String(req.body.email || "").toLowerCase().trim();
  if (!email || !validateEmailFormat(email)) return res.status(400).json({ error: "invalid_email_format" });

  const partner = await Partner.findOne({ email, isActive: true });
  if (!partner) return res.status(404).json({ error: "partner_not_found" });

  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  partner.otp = otp;
  partner.otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 mins
  await partner.save();

  try {
    await sendOTP(partner.email, otp, "PARTNER_LOGIN");
    res.json({ sent: true, email: partner.email });
  } catch (err) {
    console.error("Failed to send partner OTP:", err);
    res.status(500).json({ error: "failed_to_send_otp" });
  }
});

// Partner Login (via Email + Password/OTP)
router.post("/partner/login", rateLimit("partner-login", 10, 600), async (req, res) => {
  const email = String(req.body.email || "").toLowerCase().trim();
  const { password, otp } = req.body || {};
  
  if (!email) return res.status(400).json({ error: "missing_email" });
  if (!password && !otp) return res.status(400).json({ error: "missing_credentials" });

  const partner = await Partner.findOne({ email, isActive: true });
  if (!partner) return res.status(404).json({ error: "not_found" });
  
  if (password) {
    if (!partner.password || partner.password !== password) {
      return res.status(401).json({ error: "invalid_password" });
    }
  } else if (otp) {
    if (!partner.otp || partner.otp !== otp || new Date() > partner.otpExpiry) {
      return res.status(401).json({ error: "invalid_otp" });
    }
    // Clear OTP after use
    partner.otp = undefined;
    partner.otpExpiry = undefined;
    await partner.save();
  }
  
  const token = jwt.sign(
    { id: partner._id.toString(), role: "partner", email: partner.email },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
  
  const summary = await computeSummaryForPartner(partner);
  const safePayouts = summary.payouts.map((p) => ({
    createdAt: p.createdAt,
    amount: p.amount,
    method: p.method,
    utr: p.utr,
    razorpayPaymentId: p.razorpayPaymentId,
    notes: p.notes,
    couponCode: p.couponCode
  }));
  
  res.json({
    token,
    partnerName: summary.partnerName,
    partnerEmail: summary.partnerEmail,
    partnerPhone: summary.partnerPhone,
    totalSales: summary.totalSales,
    totalCommission: summary.totalCommission,
    totalPaid: summary.totalPaid,
    balance: summary.balance,
    coupons: summary.coupons,
    payouts: safePayouts,
    bills: summary.bills
  });
});

// Partner Signup Step 1 - Send OTP
router.post("/partner/signup", rateLimit("partner-signup", 3, 600), async (req, res) => {
  const { name, email, phone, businessName, gstNumber, panNumber, address, city, state, pincode, bloodGroup, password } = req.body;
  
  if (!name || !email || !phone || !password) {
    return res.status(400).json({ error: "missing_required_fields" });
  }
  
  if (!validateEmailFormat(email)) {
    return res.status(400).json({ error: "invalid_email_format" });
  }
  
  const existingPartner = await Partner.findOne({ email });
  if (existingPartner && existingPartner.isVerified) {
    return res.status(400).json({ error: "email_already_registered" });
  }
  
  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 mins
  
  await OTP.findOneAndUpdate(
    { email, purpose: "PARTNER_SIGNUP" },
    {
      otp,
      expiresAt,
      metadata: {
        name,
        email,
        phone,
        businessName,
        gstNumber,
        panNumber,
        address,
        city,
        state,
        pincode,
        bloodGroup,
        password
      }
    },
    { upsert: true }
  );
  
  try {
    await sendOTP(email, otp, "PARTNER_SIGNUP");
    res.json({ message: "otp_sent" });
  } catch (err) {
    console.error("Failed to send partner signup OTP:", err);
    res.status(500).json({ error: "failed_to_send_otp" });
  }
});

// Partner Signup Step 2 - Verify OTP & Create Account
router.post("/partner/verify-otp", async (req, res) => {
  const { email, otp } = req.body;
  
  if (!email || !otp) {
    return res.status(400).json({ error: "missing_fields" });
  }
  
  const record = await OTP.findOne({
    email: email.toLowerCase(),
    otp,
    purpose: "PARTNER_SIGNUP"
  });
  
  if (!record) {
    return res.status(400).json({ error: "invalid_otp" });
  }
  
  const data = record.metadata;
  
  // Create partner account
  const partner = await Partner.create({
    name: data.name,
    email: data.email.toLowerCase(),
    phone: data.phone,
    password: data.password,
    businessName: data.businessName,
    gstNumber: data.gstNumber,
    panNumber: data.panNumber,
    address: data.address,
    city: data.city,
    state: data.state,
    pincode: data.pincode,
    bloodGroup: data.bloodGroup,
    isVerified: true,
    isActive: false // Needs admin approval
  });
  
  // Delete used OTP
  await OTP.deleteOne({ _id: record._id });
  
  // Send notification to admin
  try {
    const adminEmail = process.env.ADMIN_EMAIL || process.env.SUPPORT_EMAIL;
    if (adminEmail) {
      await sendEmail({
        to: adminEmail,
        subject: `New Partner Application - ${data.name}`,
        html: `
          <div style="font-family: system-ui; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #eee; border-radius: 12px;">
            <h2 style="color:#111; margin:0 0 12px;">New Partner Application</h2>
            <p style="color:#4b5563; line-height:1.6;">A new partner has applied and verified their email!</p>
            <div style="background:#f3f4f6; border-radius:10px; padding:16px;">
              <h3 style="color:#111; margin:0 0 12px; font-size:16px;">Partner Details:</h3>
              <p style="color:#374151; margin:6px 0;"><strong>Name:</strong> ${data.name}</p>
              <p style="color:#374151; margin:6px 0;"><strong>Email:</strong> ${data.email}</p>
              <p style="color:#374151; margin:6px 0;"><strong>Phone:</strong> ${data.phone}</p>
              <p style="color:#374151; margin:6px 0;"><strong>Business:</strong> ${data.businessName || '-'}</p>
              <p style="color:#374151; margin:6px 0;"><strong>GST:</strong> ${data.gstNumber || '-'}</p>
            </div>
            <p style="color:#6b7280; margin-top:16px; font-size:14px;">Please login to admin panel to review and approve this application.</p>
          </div>
        `
      });
    }
  } catch (err) {
    console.error("Failed to send admin notification for partner signup:", err);
  }
  
  res.json({ message: "application_submitted" });
});

router.get("/partner/me", (await import("../middleware/auth.js")).auth, async (req, res) => {
  if (req.user.role !== 'partner') return res.status(403).json({ error: 'forbidden' });
  const partner = await Partner.findById(req.user.id).lean();
  if (!partner) return res.status(404).json({ error: "not_found" });
  
  // Merge summary with full partner profile
  const summary = await computeSummaryForPartner(partner);
  res.json({
    ...partner,
    ...summary
  });
});

// Update Partner Profile
router.put("/partner/profile", (await import("../middleware/auth.js")).auth, async (req, res) => {
  if (req.user.role !== 'partner') return res.status(403).json({ error: 'forbidden' });
  
  const {
    name,
    phone,
    businessName,
    gstNumber,
    panNumber,
    address,
    city,
    state,
    pincode,
    bloodGroup,
    bankAccount,
    profilePicture,
    idCard
  } = req.body;
  
  const updateData = {};
  if (name !== undefined) updateData.name = name;
  if (phone !== undefined) updateData.phone = phone;
  if (businessName !== undefined) updateData.businessName = businessName;
  if (gstNumber !== undefined) updateData.gstNumber = gstNumber;
  if (panNumber !== undefined) updateData.panNumber = panNumber;
  if (address !== undefined) updateData.address = address;
  if (city !== undefined) updateData.city = city;
  if (state !== undefined) updateData.state = state;
  if (pincode !== undefined) updateData.pincode = pincode;
  if (bloodGroup !== undefined) updateData.bloodGroup = bloodGroup;
  if (bankAccount !== undefined) updateData.bankAccount = bankAccount;
  if (profilePicture !== undefined) updateData.profilePicture = profilePicture;
  if (idCard !== undefined) updateData.idCard = idCard;
  
  const updatedPartner = await Partner.findByIdAndUpdate(req.user.id, updateData, { new: true }).lean();
  await bumpCacheVersion(`partner:summary:${req.user.id}`);
  
  // Merge summary with updated profile
  const summary = await computeSummaryForPartner(updatedPartner);
  res.json({
    ...updatedPartner,
    ...summary
  });
});

// Change Partner Password
router.put("/partner/change-password", (await import("../middleware/auth.js")).auth, async (req, res) => {
  if (req.user.role !== 'partner') return res.status(403).json({ error: 'forbidden' });

  const { currentPassword, newPassword } = req.body;

  if (!newPassword) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const partner = await Partner.findById(req.user.id);
  if (!partner) return res.status(404).json({ error: 'not_found' });

  // Only check current password if one exists and is provided
  if (partner.password && currentPassword) {
    if (partner.password !== currentPassword) {
      return res.status(401).json({ error: 'invalid_current_password' });
    }
  }

  partner.password = newPassword;
  await partner.save();

  res.json({ message: 'password_updated' });
});

// FORGOT PASSWORD - Step 1: Send OTP
router.post("/partner/forgot-password", rateLimit("partner-forgot-password", 3, 600), async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "missing_email" });
  if (!validateEmailFormat(email)) return res.status(400).json({ error: "invalid_email_format" });

  const partner = await Partner.findOne({ email: email.toLowerCase(), isActive: true });
  if (!partner) return res.status(404).json({ error: "partner_not_found" });

  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await OTP.findOneAndUpdate(
    { email: email.toLowerCase(), purpose: "PARTNER_FORGOT_PASSWORD" },
    { otp, expiresAt },
    { upsert: true }
  );

  try {
    await sendOTP(email, otp, "PARTNER_FORGOT_PASSWORD");
    res.json({ message: "otp_sent" });
  } catch (err) {
    res.status(500).json({ error: "failed_to_send_email" });
  }
});

// FORGOT PASSWORD - Step 2: Reset
router.post("/partner/reset-password", rateLimit("partner-reset-password", 5, 600), async (req, res) => {
  const { email, otp, newPassword } = req.body || {};
  if (!email || !otp || !newPassword) return res.status(400).json({ error: "missing_fields" });

  const record = await OTP.findOne({ email: email.toLowerCase(), otp, purpose: "PARTNER_FORGOT_PASSWORD" });
  if (!record) return res.status(400).json({ error: "invalid_otp" });

  const partner = await Partner.findOne({ email: email.toLowerCase() });
  if (!partner) return res.status(404).json({ error: "partner_not_found" });

  partner.password = newPassword;
  await partner.save();

  await OTP.deleteOne({ _id: record._id });

  res.json({ message: "password_reset_success" });
});

export default router;
