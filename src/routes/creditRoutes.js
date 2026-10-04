import express from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import { auth, requireRole, requirePermission } from "../middleware/auth.js";
import Customer from "../models/Customer.js";
import CreditLedger from "../models/CreditLedger.js";
import CreditRepayment from "../models/CreditRepayment.js";
import razorpay from "../lib/razorpay.js";
import {
  processSuccessfulRepayment,
  verifyBankTransferRepayment,
  rejectBankTransferRepayment,
  adjustRetailerCredit,
  toggleRetailerCredit
} from "../services/credit.service.js";
import { runReconciliation } from "../services/reconciliation.service.js";
import { sendEmail, renderMail } from "../lib/mailer.js";

const router = express.Router();

// ==========================================
// RETAILER (CUSTOMER) ENDPOINTS
// Strict ownership boundary: req.user.id
// ==========================================

/**
 * Get current retailer's credit status and balance
 */
router.get("/me", auth, requireRole("customer"), async (req, res) => {
  try {
    const customer = await Customer.findById(req.user.id).select(
      "name phone email isCreditEnabled creditLimit availableCredit usedCredit outstandingBalance deliverySettings isKycComplete"
    );

    if (!customer) return res.status(404).json({ error: "customer_not_found" });

    if (!customer.isCreditEnabled) {
      return res.status(403).json({
        error: "credit_not_enabled",
        message: "Credit facility is not enabled for your account"
      });
    }

    const limit = Number(customer.creditLimit || 0);
    const available = Number(customer.availableCredit || 0);
    const used = Number(customer.usedCredit || 0);
    const outstanding = Number(customer.outstandingBalance || 0);
    const utilization = limit > 0 ? Math.min(100, Math.max(0, Math.round(((limit - available) / limit) * 100))) : 0;

    res.json({
      isCreditEnabled: true,
      creditLimit: limit,
      availableCredit: available,
      usedCredit: used,
      outstandingBalance: outstanding,
      utilization,
      deliverySettings: customer.deliverySettings || { delhiveryEnabled: true, localDeliveryEnabled: false }
    });
  } catch (err) {
    console.error("GET /api/credit/me error:", err);
    res.status(500).json({ error: "failed_to_fetch_credit" });
  }
});

/**
 * Get current retailer's credit transaction and repayment history
 */
router.get("/me/transactions", auth, requireRole("customer"), async (req, res) => {
  try {
    const customer = await Customer.findById(req.user.id).select("isCreditEnabled");
    if (!customer || !customer.isCreditEnabled) {
      return res.status(403).json({ error: "credit_not_enabled" });
    }

    const [transactions, repayments] = await Promise.all([
      CreditLedger.find({ retailerId: req.user.id }).sort({ createdAt: -1 }).limit(100),
      CreditRepayment.find({ retailerId: req.user.id }).sort({ createdAt: -1 }).limit(50)
    ]);

    res.json({ transactions, repayments });
  } catch (err) {
    console.error("GET /api/credit/me/transactions error:", err);
    res.status(500).json({ error: "failed_to_fetch_transactions" });
  }
});

/**
 * Initiate Razorpay repayment
 */
router.post("/me/repay/razorpay-init", auth, requireRole("customer"), async (req, res) => {
  const { amount } = req.body || {};
  const numAmount = Number(amount);

  if (!numAmount || numAmount <= 0) {
    return res.status(400).json({ error: "invalid_amount" });
  }

  try {
    const customer = await Customer.findById(req.user.id);
    if (!customer || !customer.isCreditEnabled) {
      return res.status(403).json({ error: "credit_not_enabled" });
    }

    const outstanding = Number(customer.outstandingBalance || 0);
    if (outstanding <= 0) {
      return res.status(400).json({ error: "no_outstanding_balance", message: "You have no outstanding credit to repay" });
    }

    if (numAmount > outstanding) {
      return res.status(400).json({
        error: "amount_exceeds_outstanding",
        message: `Repayment amount cannot exceed outstanding balance of ₹${outstanding}`
      });
    }

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ error: "razorpay_not_configured" });
    }

    const amountPaise = Math.round(numAmount * 100);
    const rzpOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `repay_${Date.now()}`
    });

    const repayment = await CreditRepayment.create({
      retailerId: customer._id,
      amount: numAmount,
      method: "RAZORPAY",
      status: "PAYMENT_PENDING",
      razorpayOrderId: rzpOrder.id
    });

    res.json({
      repaymentId: repayment._id,
      razorpayOrderId: rzpOrder.id,
      amountPaise: rzpOrder.amount,
      keyId: process.env.RAZORPAY_KEY_ID
    });
  } catch (err) {
    console.error("POST /me/repay/razorpay-init error:", err);
    res.status(500).json({ error: "repayment_initiation_failed" });
  }
});

/**
 * Retry an existing PAYMENT_PENDING repayment request
 */
router.post("/me/repay/retry/:repaymentId", auth, requireRole("customer"), async (req, res) => {
  try {
    const repayment = await CreditRepayment.findById(req.params.repaymentId);
    if (!repayment) return res.status(404).json({ error: "repayment_not_found" });
    if (repayment.retailerId.toString() !== req.user.id) return res.status(403).json({ error: "unauthorized" });
    if (repayment.status !== "PAYMENT_PENDING") {
      return res.status(400).json({ error: "not_pending", message: `Cannot retry repayment with status '${repayment.status}'` });
    }

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ error: "razorpay_not_configured" });
    }

    const amountPaise = Math.round(repayment.amount * 100);
    const rzpOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `retry_repay_${Date.now()}`
    });

    repayment.razorpayOrderId = rzpOrder.id;
    await repayment.save();

    res.json({
      success: true,
      repaymentId: repayment._id,
      razorpayOrderId: rzpOrder.id,
      amountPaise: rzpOrder.amount,
      keyId: process.env.RAZORPAY_KEY_ID
    });
  } catch (err) {
    console.error("POST /me/repay/retry error:", err);
    res.status(500).json({ error: "repayment_retry_failed", message: err.message });
  }
});

/**
 * Verify Razorpay payment and complete repayment
 */
router.post("/me/repay/razorpay-verify", auth, requireRole("customer"), async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: "missing_payment_details" });
  }

  // Signature verification
  const body = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(body.toString())
    .digest("hex");

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json({ error: "invalid_signature" });
  }

  try {
    const repayment = await CreditRepayment.findOne({ razorpayOrderId: razorpay_order_id });
    if (!repayment) return res.status(404).json({ error: "repayment_not_found" });

    // Validate ownership boundary
    if (repayment.retailerId.toString() !== req.user.id) {
      return res.status(403).json({ error: "unauthorized" });
    }

    const result = await processSuccessfulRepayment({
      razorpayOrderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      source: "FRONTEND_VERIFY"
    });

    res.json({
      success: true,
      message: "repayment_successful",
      repayment: result.repayment
    });
  } catch (err) {
    console.error("POST /me/repay/razorpay-verify error:", err);
    res.status(500).json({ error: err.message || "repayment_verification_failed" });
  }
});

/**
 * Submit Bank Transfer repayment proof
 */
router.post("/me/repay/bank-transfer", auth, requireRole("customer"), async (req, res) => {
  const { amount, utr, paymentSlip, note, transferDate } = req.body || {};
  const numAmount = Number(amount);

  if (!numAmount || numAmount <= 0) return res.status(400).json({ error: "invalid_amount" });
  if (!utr || !String(utr).trim()) return res.status(400).json({ error: "utr_required", message: "UTR / Transaction Reference is required" });

  try {
    const customer = await Customer.findById(req.user.id);
    if (!customer || !customer.isCreditEnabled) {
      return res.status(403).json({ error: "credit_not_enabled" });
    }

    // Check duplicate UTR
    const existingUtr = await CreditRepayment.findOne({ "bankTransferDetails.utr": String(utr).trim(), status: { $ne: "REJECTED" } });
    if (existingUtr) {
      return res.status(400).json({ error: "duplicate_utr", message: "This UTR has already been submitted" });
    }

    const repayment = await CreditRepayment.create({
      retailerId: customer._id,
      amount: numAmount,
      method: "BANK_TRANSFER",
      status: "PENDING_VERIFICATION",
      bankTransferDetails: {
        utr: String(utr).trim(),
        paymentSlip: paymentSlip || "",
        note: note || "",
        transferDate: transferDate ? new Date(transferDate) : new Date()
      }
    });

    res.status(201).json({
      success: true,
      message: "repayment_submitted_for_verification",
      repayment
    });
  } catch (err) {
    console.error("POST /me/repay/bank-transfer error:", err);
    res.status(500).json({ error: "failed_to_submit_repayment" });
  }
});

// ==========================================
// ADMIN ENDPOINTS
// Requires admin role or permission: customers
// ==========================================

/**
 * List all retailers with credit management status and overview stats
 */
router.get("/admin/retailers", auth, requirePermission("customers"), async (req, res) => {
  try {
    const { q, status, page = 1, limit = 20 } = req.query;
    const filter = {};

    if (q) {
      const regex = new RegExp(q.trim(), "i");
      filter.$or = [
        { name: regex },
        { phone: regex },
        { email: regex },
        { "kyc.businessName": regex }
      ];
    }

    if (status === "enabled") {
      filter.isCreditEnabled = true;
    } else if (status === "disabled") {
      filter.isCreditEnabled = { $ne: true };
    }

    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, Math.max(1, parseInt(limit)));

    const [items, total] = await Promise.all([
      Customer.find(filter)
        .select("-password")
        .sort({ isCreditEnabled: -1, updatedAt: -1 })
        .skip((p - 1) * l)
        .limit(l),
      Customer.countDocuments(filter)
    ]);

    // Aggregate overall statistics
    const statsAgg = await Customer.aggregate([
      {
        $group: {
          _id: null,
          totalLimit: { $sum: { $cond: [{ $eq: ["$isCreditEnabled", true] }, "$creditLimit", 0] } },
          totalAvailable: { $sum: { $cond: [{ $eq: ["$isCreditEnabled", true] }, "$availableCredit", 0] } },
          totalUsed: { $sum: { $cond: [{ $eq: ["$isCreditEnabled", true] }, "$usedCredit", 0] } },
          totalOutstanding: { $sum: { $cond: [{ $eq: ["$isCreditEnabled", true] }, "$outstandingBalance", 0] } },
          enabledCount: { $sum: { $cond: [{ $eq: ["$isCreditEnabled", true] }, 1, 0] } }
        }
      }
    ]);

    const stats = statsAgg[0] || {
      totalLimit: 0,
      totalAvailable: 0,
      totalUsed: 0,
      totalOutstanding: 0,
      enabledCount: 0
    };

    res.json({
      items,
      total,
      page: p,
      limit: l,
      stats: {
        totalLimit: stats.totalLimit,
        totalAvailable: stats.totalAvailable,
        totalUsed: stats.totalUsed,
        totalOutstanding: stats.totalOutstanding,
        enabledCount: stats.enabledCount
      }
    });
  } catch (err) {
    console.error("GET /api/credit/admin/retailers error:", err);
    res.status(500).json({ error: "failed_to_fetch_retailers" });
  }
});

/**
 * Get individual retailer credit profile & history
 */
router.get("/admin/retailers/:id", auth, requirePermission("customers"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });

  try {
    const customer = await Customer.findById(req.params.id).select("-password");
    if (!customer) return res.status(404).json({ error: "retailer_not_found" });

    const [transactions, repayments] = await Promise.all([
      CreditLedger.find({ retailerId: customer._id }).sort({ createdAt: -1 }).limit(100),
      CreditRepayment.find({ retailerId: customer._id }).sort({ createdAt: -1 }).limit(50)
    ]);

    res.json({
      retailer: customer,
      transactions,
      repayments
    });
  } catch (err) {
    console.error("GET /api/credit/admin/retailers/:id error:", err);
    res.status(500).json({ error: "failed_to_fetch_retailer_credit" });
  }
});

/**
 * Toggle credit enabled/disabled and optionally set initial limit
 */
router.post("/admin/retailers/:id/toggle", auth, requirePermission("customers"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const { isCreditEnabled, creditLimit, reason } = req.body || {};

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: "reason_required", message: "Audit reason is required to toggle credit" });
  }

  try {
    const result = await toggleRetailerCredit({
      retailerId: req.params.id,
      adminId: req.user.id,
      adminName: req.user.name || "Admin",
      isCreditEnabled,
      creditLimit,
      reason
    });

    res.json({ success: true, customer: result.customer, ledger: result.ledger });
  } catch (err) {
    console.error("POST /admin/retailers/:id/toggle error:", err);
    res.status(400).json({ error: err.message || "failed_to_toggle_credit" });
  }
});

/**
 * Set or change credit limit for a retailer
 */
router.post("/admin/retailers/:id/set-limit", auth, requirePermission("customers"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const { creditLimit, reason } = req.body || {};

  if (creditLimit === undefined || Number(creditLimit) < 0) {
    return res.status(400).json({ error: "invalid_limit", message: "Credit limit must be 0 or positive" });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: "reason_required", message: "Audit reason is required to modify credit limit" });
  }

  try {
    const result = await toggleRetailerCredit({
      retailerId: req.params.id,
      adminId: req.user.id,
      adminName: req.user.name || "Admin",
      isCreditEnabled: true,
      creditLimit: Number(creditLimit),
      reason
    });

    res.json({ success: true, customer: result.customer, ledger: result.ledger });
  } catch (err) {
    console.error("POST /admin/retailers/:id/set-limit error:", err);
    res.status(400).json({ error: err.message || "failed_to_set_limit" });
  }
});

/**
 * Manually adjust credit (INCREASE or DECREASE) with audit logging
 */
router.post("/admin/retailers/:id/adjust", auth, requirePermission("customers"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const { amount, type, reason } = req.body || {};

  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: "invalid_amount", message: "Adjustment amount must be positive" });
  }
  if (!["INCREASE", "DECREASE"].includes(type)) {
    return res.status(400).json({ error: "invalid_type", message: "Type must be INCREASE or DECREASE" });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: "reason_required", message: "Audit reason is required for manual adjustment" });
  }

  try {
    const result = await adjustRetailerCredit({
      retailerId: req.params.id,
      adminId: req.user.id,
      adminName: req.user.name || "Admin",
      amount: Number(amount),
      type,
      reason
    });

    res.json({ success: true, customer: result.customer, ledger: result.ledger });
  } catch (err) {
    console.error("POST /admin/retailers/:id/adjust error:", err);
    res.status(400).json({ error: err.message || "failed_to_adjust_credit" });
  }
});

/**
 * List repayments for admin verification
 */
router.get("/admin/repayments", auth, requirePermission("customers"), async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status && status !== "ALL") filter.status = status;

    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, Math.max(1, parseInt(limit)));

    const [items, total] = await Promise.all([
      CreditRepayment.find(filter)
        .populate("retailerId", "name phone email kyc")
        .sort({ createdAt: -1 })
        .skip((p - 1) * l)
        .limit(l),
      CreditRepayment.countDocuments(filter)
    ]);

    res.json({ items, total, page: p, limit: l });
  } catch (err) {
    console.error("GET /admin/repayments error:", err);
    res.status(500).json({ error: "failed_to_fetch_repayments" });
  }
});

/**
 * Admin verify Bank Transfer repayment
 */
router.post("/admin/repayments/:id/verify", auth, requirePermission("customers"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const { notes } = req.body || {};

  try {
    const result = await verifyBankTransferRepayment({
      repaymentId: req.params.id,
      adminId: req.user.id,
      adminName: req.user.name || "Admin",
      notes
    });

    res.json({ success: true, repayment: result.repayment, ledger: result.ledger });
  } catch (err) {
    console.error("POST /admin/repayments/:id/verify error:", err);
    res.status(400).json({ error: err.message || "verification_failed" });
  }
});

/**
 * Admin reject Bank Transfer repayment
 */
router.post("/admin/repayments/:id/reject", auth, requirePermission("customers"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const { reason } = req.body || {};

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: "reason_required", message: "Rejection reason is required" });
  }

  try {
    const result = await rejectBankTransferRepayment({
      repaymentId: req.params.id,
      adminId: req.user.id,
      adminName: req.user.name || "Admin",
      reason
    });

    res.json({ success: true, repayment: result });
  } catch (err) {
    console.error("POST /admin/repayments/:id/reject error:", err);
    res.status(400).json({ error: err.message || "rejection_failed" });
  }
});

/**
 * Trigger reconciliation of pending orders and credit repayments
 */
router.post("/admin/reconcile", auth, requirePermission("orders"), async (req, res) => {
  try {
    const report = await runReconciliation();
    res.json({ success: true, report });
  } catch (err) {
    console.error("POST /admin/reconcile error:", err);
    res.status(500).json({ error: "reconciliation_failed", message: err.message });
  }
});

/**
 * Notify all credit-enabled retailers who have outstanding credit dues
 * Optional: body { retailerId } to notify a specific retailer
 */
router.post("/admin/notify-outstanding", auth, requirePermission("customers"), async (req, res) => {
  try {
    const { retailerId } = req.body || {};
    const query = {
      isCreditEnabled: true,
      outstandingBalance: { $gt: 0 }
    };
    if (retailerId) {
      if (!mongoose.isValidObjectId(retailerId)) {
        return res.status(400).json({ error: "invalid_retailer_id" });
      }
      query._id = retailerId;
    }

    const debtors = await Customer.find(query).select(
      "name email phone outstandingBalance creditLimit availableCredit"
    );

    if (!debtors || debtors.length === 0) {
      return res.json({
        success: true,
        totalDebtors: 0,
        sentCount: 0,
        failedCount: 0,
        message: "No retailers with outstanding balance found."
      });
    }

    const company = process.env.COMPANY_NAME || "Click2Kart";
    const portalUrl = `${(process.env.CLIENT_URL && process.env.CLIENT_URL.replace(/\/$/, "")) || "https://click2kart.net"}/profile`;
    let sentCount = 0;
    let failedCount = 0;

    for (const retailer of debtors) {
      if (!retailer.email) {
        failedCount++;
        continue;
      }
      try {
        const outAmount = Number(retailer.outstandingBalance || 0);
        const limit = Number(retailer.creditLimit || 0);
        const avail = Number(retailer.availableCredit || 0);

        const html = renderMail({
          heading: "Credit Statement & Repayment Notice",
          subheading: `Dear ${retailer.name || "Valued Retailer"}, this is an official reminder regarding your active wholesale credit line with ${company}.`,
          highlight: `Total Outstanding Due: ₹${outAmount.toLocaleString("en-IN")}`,
          blocks: [
            { label: "Account Holder", value: retailer.name || "Retailer" },
            { label: "Registered Phone", value: retailer.phone || "—" },
            { label: "Assigned Credit Limit", value: `₹${limit.toLocaleString("en-IN")}` },
            { label: "Current Outstanding", value: `₹${outAmount.toLocaleString("en-IN")}` },
            { label: "Available Credit", value: `₹${avail.toLocaleString("en-IN")}` },
            {
              label: "Important Notice",
              value: "Please clear your outstanding balance promptly to maintain an uninterrupted credit facility and avoid account suspension or late charges."
            },
            {
              label: "Repay Online",
              value: `<a href="${portalUrl}" style="display:inline-block;padding:10px 20px;background:#7c3aed;color:#ffffff;text-decoration:none;border-radius:12px;font-weight:800;font-size:12px;">Go to Retailer Repayment Portal →</a>`
            }
          ]
        });

        await sendEmail({
          to: retailer.email,
          subject: `Payment Reminder: Outstanding Credit Balance Due - ${company}`,
          html
        });
        sentCount++;
      } catch (mailErr) {
        console.error(`Failed to send credit reminder to ${retailer.email}:`, mailErr);
        failedCount++;
      }
    }

    res.json({
      success: true,
      totalDebtors: debtors.length,
      sentCount,
      failedCount,
      message: `Notifications sent to ${sentCount} retailer(s)${failedCount > 0 ? `, ${failedCount} could not be sent (missing or invalid email)` : ""}.`
    });
  } catch (err) {
    console.error("POST /admin/notify-outstanding error:", err);
    res.status(500).json({ error: "failed_to_notify_outstanding", message: err.message });
  }
});

export default router;
