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

// Business Credit Line Models and Services
import BusinessCreditApplication from "../models/BusinessCreditApplication.js";
import BusinessCreditFacility from "../models/BusinessCreditFacility.js";
import BusinessCreditSchedule from "../models/BusinessCreditSchedule.js";
import BusinessCreditTransaction from "../models/BusinessCreditTransaction.js";
import CreditProductSettings from "../models/CreditProductSettings.js";
import {
  getProductSettings,
  checkRetailerEligibility,
  submitApplication,
  adminReviewApplication,
  adminProactiveGrant,
  acceptOffer,
  confirmDisbursement,
  processBusinessRepayment,
  reverseBusinessRepayment,
  accrueDailyInterestForActiveFacilities,
  verifyFacilityInvariants,
  reconcileFacilityInvariants
} from "../services/businessCredit.service.js";
import {
  createAutoPayMandateOrder,
  verifyAutoPayWebhookSignature,
  handleAutoPayWebhookEvent
} from "../services/autopay.service.js";
import { generateBureauReport } from "../services/creditBureau.service.js";

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
// RETAILER BUSINESS CREDIT LINE ENDPOINTS
// ==========================================

/**
 * Check retailer eligibility for Business Credit Line
 */
router.get("/business/eligibility", auth, requireRole("customer"), async (req, res) => {
  try {
    const eligibility = await checkRetailerEligibility(req.user.id);
    res.json(eligibility);
  } catch (err) {
    console.error("GET /business/eligibility error:", err);
    res.status(500).json({ error: "failed_to_check_eligibility", message: err.message });
  }
});

/**
 * Retailer submits Business Credit Line application
 */
router.post("/business/apply", auth, requireRole("customer"), async (req, res) => {
  try {
    const { requestedAmount, purpose, requestedTenureMonths, requestedFrequency } = req.body || {};

    const application = await submitApplication({
      retailerId: req.user.id,
      requestedAmount,
      purpose,
      requestedTenureMonths,
      requestedFrequency
    });

    res.status(201).json({
      success: true,
      message: "business_credit_application_submitted",
      application
    });
  } catch (err) {
    console.error("POST /business/apply error:", err);
    res.status(400).json({ error: "application_submission_failed", message: err.message });
  }
});

/**
 * Retailer retrieves their Business Credit applications
 */
router.get("/business/my-applications", auth, requireRole("customer"), async (req, res) => {
  try {
    const applications = await BusinessCreditApplication.find({ retailerId: req.user.id }).sort({ createdAt: -1 });
    res.json({ applications });
  } catch (err) {
    console.error("GET /business/my-applications error:", err);
    res.status(500).json({ error: "failed_to_fetch_applications", message: err.message });
  }
});

/**
 * Retailer retrieves active Business Credit facilities, schedules, and transactions
 */
router.get("/business/my-facilities", auth, requireRole("customer"), async (req, res) => {
  try {
    const facilities = await BusinessCreditFacility.find({ retailerId: req.user.id }).sort({ createdAt: -1 });

    const facilityDetails = await Promise.all(
      facilities.map(async fac => {
        const [schedules, recentTransactions] = await Promise.all([
          BusinessCreditSchedule.find({ facilityId: fac._id }).sort({ instalmentNumber: 1 }),
          BusinessCreditTransaction.find({ facilityId: fac._id }).sort({ createdAt: -1 }).limit(25)
        ]);

        return {
          ...fac.toObject(),
          schedules,
          recentTransactions
        };
      })
    );

    res.json({ facilities: facilityDetails });
  } catch (err) {
    console.error("GET /business/my-facilities error:", err);
    res.status(500).json({ error: "failed_to_fetch_facilities", message: err.message });
  }
});

/**
 * Retailer accepts an approved or proactive Business Credit offer
 */
router.post("/business/accept-offer/:id", auth, requireRole("customer"), async (req, res) => {
  try {
    const ipAddress = req.ip || req.headers["x-forwarded-for"] || "127.0.0.1";
    const userAgent = req.headers["user-agent"] || "Web Browser";

    const result = await acceptOffer({
      applicationId: req.params.id,
      retailerId: req.user.id,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: "business_credit_offer_accepted",
      application: result.application,
      facility: result.facility
    });
  } catch (err) {
    console.error("POST /business/accept-offer error:", err);
    res.status(400).json({ error: "offer_acceptance_failed", message: err.message });
  }
});

/**
 * Initiate Razorpay Repayment for Business Credit Facility
 */
router.post("/business/repay/razorpay-init", auth, requireRole("customer"), async (req, res) => {
  const { facilityId, amount } = req.body || {};
  const numAmount = Number(amount);

  if (!facilityId) return res.status(400).json({ error: "facility_id_required" });
  if (!numAmount || numAmount <= 0) return res.status(400).json({ error: "invalid_amount" });

  try {
    const facility = await BusinessCreditFacility.findOne({ _id: facilityId, retailerId: req.user.id });
    if (!facility) return res.status(404).json({ error: "facility_not_found" });

    if (facility.status === "CLOSED") {
      return res.status(400).json({ error: "facility_already_closed", message: "This facility has already been fully paid off." });
    }

    if (numAmount > facility.totalPayable) {
      return res.status(400).json({
        error: "amount_exceeds_total_payable",
        message: `Amount ₹${numAmount} exceeds remaining total payable ₹${facility.totalPayable}`
      });
    }

    const options = {
      amount: Math.round(numAmount * 100), // paise
      currency: "INR",
      receipt: `bcrep_${facility.facilityNumber.slice(-6)}_${Date.now()}`.slice(0, 40),
      notes: {
        type: "BUSINESS_CREDIT_REPAYMENT",
        facilityId: facility._id.toString(),
        facilityNumber: facility.facilityNumber,
        retailerId: req.user.id
      }
    };

    const order = await razorpay.orders.create(options);

    res.json({
      success: true,
      order,
      facility: {
        _id: facility._id,
        facilityNumber: facility.facilityNumber,
        totalPayable: facility.totalPayable
      },
      key: process.env.RAZORPAY_KEY_ID
    });
  } catch (err) {
    console.error("POST /business/repay/razorpay-init error:", err);
    res.status(500).json({ error: "failed_to_initiate_repayment", message: err.message });
  }
});

/**
 * Verify Razorpay Repayment for Business Credit Facility
 */
router.post("/business/repay/razorpay-verify", auth, requireRole("customer"), async (req, res) => {
  const { facilityId, razorpay_order_id, razorpay_payment_id, razorpay_signature, amount } = req.body || {};

  if (!facilityId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: "missing_payment_verification_parameters" });
  }

  // Cryptographic signature check
  const body = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(body.toString())
    .digest("hex");

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json({ error: "invalid_signature", message: "Razorpay payment verification failed" });
  }

  try {
    const facility = await BusinessCreditFacility.findOne({ _id: facilityId, retailerId: req.user.id });
    if (!facility) return res.status(404).json({ error: "facility_not_found" });

    const result = await processBusinessRepayment({
      facilityId: facility._id,
      amount: Number(amount),
      paymentMode: "RAZORPAY",
      paymentReference: razorpay_payment_id,
      notes: `Razorpay Online Repayment (Order: ${razorpay_order_id})`,
      razorpayPaymentId: razorpay_payment_id,
      razorpayOrderId: razorpay_order_id,
      razorpaySignature
    });

    res.json({
      success: true,
      message: "repayment_successfully_applied",
      facility: result.facility,
      allocation: result.allocation,
      transaction: result.transaction
    });
  } catch (err) {
    console.error("POST /business/repay/razorpay-verify error:", err);
    res.status(500).json({ error: "failed_to_apply_repayment", message: err.message });
  }
});

/**
 * Retailer submits Bank Transfer Repayment Proof for Business Credit Facility
 */
router.post("/business/repay/bank-transfer", auth, requireRole("customer"), async (req, res) => {
  const { facilityId, amount, utr, paymentSlip, notes } = req.body || {};
  const numAmount = Number(amount);

  if (!facilityId) return res.status(400).json({ error: "facility_id_required" });
  if (!numAmount || numAmount <= 0) return res.status(400).json({ error: "invalid_amount" });
  if (!utr || !String(utr).trim()) return res.status(400).json({ error: "utr_required" });

  try {
    const facility = await BusinessCreditFacility.findOne({ _id: facilityId, retailerId: req.user.id });
    if (!facility) return res.status(404).json({ error: "facility_not_found" });

    const cleanUtr = String(utr).trim();
    // Check duplicate UTR on business credit transactions
    const existingUtr = await BusinessCreditTransaction.findOne({
      facilityId: facility._id,
      $or: [
        { "paymentDetails.utr": cleanUtr },
        { idempotencyKey: `BANK-UTR-${cleanUtr}` }
      ]
    });
    if (existingUtr) {
      return res.status(400).json({ error: "duplicate_utr", message: "This UTR has already been submitted for a transaction." });
    }

    // Record pending bank transfer repayment transaction with correct schema fields
    const txn = await BusinessCreditTransaction.create({
      facilityId: facility._id,
      retailerId: req.user.id,
      type: "REPAYMENT",
      amount: numAmount,
      principalComponent: 0,
      interestComponent: 0,
      feeComponent: 0,
      principalOutstandingBefore: facility.principalOutstanding,
      principalOutstandingAfter: facility.principalOutstanding,
      interestOutstandingBefore: facility.interestOutstanding,
      interestOutstandingAfter: facility.interestOutstanding,
      totalPayableBefore: facility.totalPayable,
      totalPayableAfter: facility.totalPayable,
      method: "BANK_TRANSFER",
      paymentDetails: {
        utr: cleanUtr,
        paymentSlip: paymentSlip || "",
        notes: notes || `Direct Bank Transfer (UTR: ${cleanUtr})`,
        status: "PENDING_VERIFICATION"
      },
      idempotencyKey: `BANK-UTR-${cleanUtr}`,
      reason: `Direct bank transfer repayment proof submitted by retailer (UTR: ${cleanUtr})`,
      createdBy: String(req.user.id),
      createdByName: req.user.name || "Retailer"
    });

    res.status(201).json({
      success: true,
      message: "bank_transfer_submitted_for_admin_verification",
      transaction: txn
    });
  } catch (err) {
    console.error("POST /business/repay/bank-transfer error:", err);
    res.status(500).json({ error: "failed_to_submit_bank_transfer", message: err.message });
  }
});

/**
 * Initiate AutoPay Mandate Order for Business Credit Facility
 */
router.post("/business/mandate/init", auth, requireRole("customer"), async (req, res) => {
  const { facilityId } = req.body || {};
  if (!facilityId) return res.status(400).json({ error: "facility_id_required" });

  try {
    const facility = await BusinessCreditFacility.findOne({ _id: facilityId, retailerId: req.user.id });
    if (!facility) return res.status(404).json({ error: "facility_not_found" });

    const customer = await Customer.findById(req.user.id);

    const mandateResult = await createAutoPayMandateOrder({
      facilityId: facility._id,
      customerPhone: customer?.phone,
      customerEmail: customer?.email,
      customerName: customer?.name
    });

    res.json({
      success: true,
      mandate: mandateResult,
      message: mandateResult.message
    });
  } catch (err) {
    console.error("POST /business/mandate/init error:", err);
    res.status(500).json({ error: "failed_to_initiate_mandate", message: err.message });
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

// ==========================================
// ADMIN BUSINESS CREDIT MANAGEMENT ENDPOINTS
// Requires admin role or permission: customers
// ==========================================

/**
 * Get Business Credit Product Settings
 */
router.get("/admin/business/settings", auth, requirePermission("customers"), async (req, res) => {
  try {
    const settings = await getProductSettings();
    res.json({ settings });
  } catch (err) {
    console.error("GET /admin/business/settings error:", err);
    res.status(500).json({ error: "failed_to_fetch_settings", message: err.message });
  }
});

/**
 * Update Business Credit Product Settings
 */
router.put("/admin/business/settings", auth, requirePermission("customers"), async (req, res) => {
  try {
    const {
      isProductEnabled,
      isEnabled,
      defaultAnnualInterestRatePercent,
      interestRatePerAnnum,
      minAnnualInterestRatePercent,
      maxAnnualInterestRatePercent,
      defaultTenureMonths,
      minTenureMonths,
      maxTenureMonths,
      permittedTenures,
      processingFeePercent,
      processingFeeValue,
      minCreditLimit,
      minAmount,
      maxCreditLimit,
      maxAmount
    } = req.body || {};

    const settings = await getProductSettings();

    if (isProductEnabled !== undefined) settings.isEnabled = Boolean(isProductEnabled);
    if (isEnabled !== undefined) settings.isEnabled = Boolean(isEnabled);
    if (defaultAnnualInterestRatePercent !== undefined) settings.interestRatePerAnnum = Number(defaultAnnualInterestRatePercent);
    if (interestRatePerAnnum !== undefined) settings.interestRatePerAnnum = Number(interestRatePerAnnum);
    
    // Configurable tenure validation
    if (minTenureMonths !== undefined) {
      const t = Number(minTenureMonths);
      if (t < 1 || t > 12) return res.status(400).json({ error: "invalid_min_tenure", message: "Minimum tenure must be between 1 and 12 months." });
      settings.minTenureMonths = t;
    }
    if (maxTenureMonths !== undefined) {
      const t = Number(maxTenureMonths);
      if (t < 1 || t > 12) return res.status(400).json({ error: "invalid_max_tenure", message: "Maximum tenure must be between 1 and 12 months." });
      settings.maxTenureMonths = t;
    }
    if (defaultTenureMonths !== undefined) {
      const t = Number(defaultTenureMonths);
      if (t < 1 || t > 12) return res.status(400).json({ error: "invalid_tenure", message: "Default tenure must be between 1 and 12 months." });
      settings.defaultTenureMonths = t;
    }
    if (permittedTenures !== undefined && Array.isArray(permittedTenures)) {
      settings.permittedTenures = permittedTenures.map(Number).filter(n => n >= 1 && n <= 12);
    }

    if (processingFeePercent !== undefined) settings.processingFeeValue = Number(processingFeePercent);
    if (processingFeeValue !== undefined) settings.processingFeeValue = Number(processingFeeValue);
    if (minCreditLimit !== undefined) settings.minAmount = Number(minCreditLimit);
    if (minAmount !== undefined) settings.minAmount = Number(minAmount);
    if (maxCreditLimit !== undefined) settings.maxAmount = Number(maxCreditLimit);
    if (maxAmount !== undefined) settings.maxAmount = Number(maxAmount);

    await settings.save();

    res.json({ success: true, message: "settings_updated", settings });
  } catch (err) {
    console.error("PUT /admin/business/settings error:", err);
    res.status(500).json({ error: "failed_to_update_settings", message: err.message });
  }
});

/**
 * List Business Credit Applications
 */
router.get("/admin/business/applications", auth, requirePermission("customers"), async (req, res) => {
  try {
    const { status, page = 1, limit = 20, q } = req.query;
    const filter = {};

    if (status && status !== "ALL") {
      filter.status = status;
    }

    if (q) {
      const regex = new RegExp(q.trim(), "i");
      const matchedCustomers = await Customer.find({
        $or: [{ name: regex }, { phone: regex }, { email: regex }, { "kyc.businessName": regex }]
      }).select("_id");
      filter.retailerId = { $in: matchedCustomers.map(c => c._id) };
    }

    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, Math.max(1, parseInt(limit)));

    const [applications, total] = await Promise.all([
      BusinessCreditApplication.find(filter)
        .populate("retailerId", "name email phone kyc creditLimit availableCredit outstandingBalance")
        .sort({ createdAt: -1 })
        .skip((p - 1) * l)
        .limit(l),
      BusinessCreditApplication.countDocuments(filter)
    ]);

    res.json({
      applications,
      pagination: {
        page: p,
        limit: l,
        total,
        pages: Math.ceil(total / l)
      }
    });
  } catch (err) {
    console.error("GET /admin/business/applications error:", err);
    res.status(500).json({ error: "failed_to_fetch_applications", message: err.message });
  }
});

/**
 * Admin review (Approve, Partial Approve, Reject, Request Info) for Business Credit Application
 */
router.post("/admin/business/applications/:id/review", auth, requirePermission("customers"), async (req, res) => {
  try {
    const {
      action,
      approvedLimit,
      approvedAmount,
      approvedTenureMonths,
      approvedFrequency,
      repaymentFrequency,
      annualInterestRatePercent,
      interestRate,
      processingFeePercent,
      processingFeeValue,
      processingFeeType,
      rejectionReason,
      remarks,
      adminNotes
    } = req.body || {};

    const updatedApp = await adminReviewApplication({
      applicationId: req.params.id,
      adminId: req.user?._id || req.user?.id,
      adminName: req.user?.name || "Admin",
      action,
      approvedAmount: approvedAmount !== undefined ? approvedAmount : approvedLimit,
      approvedTenureMonths,
      interestRate: interestRate !== undefined ? interestRate : annualInterestRatePercent,
      processingFeeType: processingFeeType || "PERCENTAGE",
      processingFeeValue: processingFeeValue !== undefined ? processingFeeValue : processingFeePercent,
      repaymentFrequency: repaymentFrequency || approvedFrequency,
      adminNotes: adminNotes || remarks,
      rejectionReason
    });

    res.json({
      success: true,
      message: `application_${String(action || "").toLowerCase()}`,
      application: updatedApp
    });
  } catch (err) {
    console.error("POST /admin/business/applications/:id/review error:", err);
    res.status(400).json({ error: "review_failed", message: err.message });
  }
});

/**
 * Admin Proactive Credit Grant to eligible retailer
 */
router.post("/admin/business/proactive-grant", auth, requirePermission("customers"), async (req, res) => {
  try {
    const {
      retailerId,
      approvedLimit,
      approvedAmount,
      approvedTenureMonths,
      approvedFrequency,
      repaymentFrequency,
      annualInterestRatePercent,
      interestRate,
      processingFeePercent,
      processingFeeValue,
      purpose,
      reason,
      remarks,
      adminNotes
    } = req.body || {};

    const application = await adminProactiveGrant({
      retailerId,
      adminId: req.user?._id || req.user?.id,
      adminName: req.user?.name || "Admin",
      approvedAmount: approvedAmount !== undefined ? approvedAmount : approvedLimit,
      approvedTenureMonths,
      interestRate: interestRate !== undefined ? interestRate : annualInterestRatePercent,
      processingFeeValue: processingFeeValue !== undefined ? processingFeeValue : processingFeePercent,
      repaymentFrequency: repaymentFrequency || approvedFrequency,
      reason: reason || purpose,
      adminNotes: adminNotes || remarks
    });

    res.status(201).json({
      success: true,
      message: "proactive_credit_granted_successfully",
      application
    });
  } catch (err) {
    console.error("POST /admin/business/proactive-grant error:", err);
    res.status(400).json({ error: "proactive_grant_failed", message: err.message });
  }
});

/**
 * Admin Confirms Bank Transfer / Disbursement of approved loan
 */
router.post("/admin/business/applications/:id/disburse", auth, requirePermission("customers"), async (req, res) => {
  try {
    const {
      bankTransferReference,
      utr,
      disbursementMode,
      method,
      remarks,
      notes,
      accountHolder,
      accountNumber,
      ifsc,
      bankName,
      disbursementDate
    } = req.body || {};

    const result = await confirmDisbursement({
      applicationId: req.params.id,
      adminId: req.user?._id || req.user?.id,
      adminName: req.user?.name || "Admin",
      utr: utr || bankTransferReference,
      method: method || disbursementMode || "BANK_TRANSFER",
      accountHolder,
      accountNumber,
      ifsc,
      bankName,
      notes: notes || remarks,
      disbursementDate
    });

    res.json({
      success: true,
      message: "disbursement_confirmed_and_facility_activated",
      facility: result.facility,
      schedulesCount: result.schedules.length
    });
  } catch (err) {
    console.error("POST /admin/business/applications/:id/disburse error:", err);
    res.status(400).json({ error: "disbursement_failed", message: err.message });
  }
});

/**
 * List all Business Credit Facilities with detailed schedules
 */
router.get("/admin/business/facilities", auth, requirePermission("customers"), async (req, res) => {
  try {
    const { status, page = 1, limit = 20, q } = req.query;
    const filter = {};

    if (status && status !== "ALL") {
      filter.status = status;
    }

    if (q) {
      const regex = new RegExp(q.trim(), "i");
      const matchedCustomers = await Customer.find({
        $or: [{ name: regex }, { phone: regex }, { email: regex }, { "kyc.businessName": regex }]
      }).select("_id");
      filter.$or = [
        { facilityNumber: regex },
        { retailerId: { $in: matchedCustomers.map(c => c._id) } }
      ];
    }

    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, Math.max(1, parseInt(limit)));

    const [facilities, total] = await Promise.all([
      BusinessCreditFacility.find(filter)
        .populate("retailerId", "name email phone kyc")
        .sort({ createdAt: -1 })
        .skip((p - 1) * l)
        .limit(l),
      BusinessCreditFacility.countDocuments(filter)
    ]);

    const detailedFacilities = await Promise.all(
      facilities.map(async fac => {
        const [schedules, recentTransactions] = await Promise.all([
          BusinessCreditSchedule.find({ facilityId: fac._id }).sort({ instalmentNumber: 1 }),
          BusinessCreditTransaction.find({ facilityId: fac._id }).sort({ createdAt: -1 }).limit(10)
        ]);
        return {
          ...fac.toObject(),
          schedules,
          recentTransactions
        };
      })
    );

    res.json({
      facilities: detailedFacilities,
      pagination: {
        page: p,
        limit: l,
        total,
        pages: Math.ceil(total / l)
      }
    });
  } catch (err) {
    console.error("GET /admin/business/facilities error:", err);
    res.status(500).json({ error: "failed_to_fetch_facilities", message: err.message });
  }
});

/**
 * Admin manual repayment recording / offline bank transfer reconciliation for a facility
 */
router.post("/admin/business/facilities/:id/repay-reconcile", auth, requirePermission("customers"), async (req, res) => {
  try {
    const { amount, paymentMode, paymentReference, notes, transactionIdToVerify } = req.body || {};
    const numAmount = Number(amount);

    if (!numAmount || numAmount <= 0) return res.status(400).json({ error: "invalid_amount" });

    // If reconciling an existing PENDING_VERIFICATION transaction
    if (transactionIdToVerify) {
      const pendingTxn = await BusinessCreditTransaction.findById(transactionIdToVerify);
      if (pendingTxn && pendingTxn.status === "PENDING_VERIFICATION") {
        pendingTxn.status = "SUCCESS";
        pendingTxn.metadata = { ...pendingTxn.metadata, verifiedByAdminId: req.user.id, verifiedAt: new Date() };
        await pendingTxn.save();
      }
    }

    const result = await processBusinessRepayment({
      facilityId: req.params.id,
      amount: numAmount,
      paymentMode: paymentMode || "BANK_TRANSFER",
      paymentReference: paymentReference || `ADMIN_REC_${Date.now()}`,
      notes: notes || `Admin Manual Reconciliation by ${req.user.name || "Admin"}`,
      receivedByAdminId: req.user.id
    });

    res.json({
      success: true,
      message: "repayment_reconciled_successfully",
      facility: result.facility,
      allocation: result.allocation,
      transaction: result.transaction
    });
  } catch (err) {
    console.error("POST /admin/business/facilities/:id/repay-reconcile error:", err);
    res.status(400).json({ error: "repayment_reconciliation_failed", message: err.message });
  }
});

/**
 * Admin manual trigger for daily interest accrual
 */
router.post("/admin/business/run-accrual", auth, requirePermission("customers"), async (req, res) => {
  try {
    const result = await accrueDailyInterestForActiveFacilities();
    res.json({
      success: true,
      message: "daily_accrual_completed",
      result
    });
  } catch (err) {
    console.error("POST /admin/business/run-accrual error:", err);
    res.status(500).json({ error: "accrual_run_failed", message: err.message });
  }
});

/**
 * Admin extract structured credit bureau reporting dataset (CIBIL / Equifax format)
 */
router.get("/admin/business/bureau-report", auth, requirePermission("customers"), async (req, res) => {
  try {
    const { statusFilter } = req.query;
    const report = await generateBureauReport({ statusFilter });
    res.json(report);
  } catch (err) {
    console.error("GET /admin/business/bureau-report error:", err);
    res.status(500).json({ error: "failed_to_generate_bureau_report", message: err.message });
  }
});

/**
 * Admin invariant integrity check for a business facility
 */
router.get("/admin/business/facilities/:id/invariants", auth, requirePermission("customers"), async (req, res) => {
  try {
    const report = await verifyFacilityInvariants(req.params.id);
    res.json({ success: true, report });
  } catch (err) {
    console.error("GET /admin/business/facilities/:id/invariants error:", err);
    res.status(500).json({ error: "invariant_check_failed", message: err.message });
  }
});

/**
 * Admin audited reconciliation of facility invariants
 */
router.post("/admin/business/facilities/:id/reconcile-invariants", auth, requirePermission("customers"), async (req, res) => {
  try {
    const { reason, autoFix } = req.body || {};
    const report = await reconcileFacilityInvariants({
      facilityId: req.params.id,
      autoFix: autoFix !== false,
      adminId: req.user.id,
      adminName: req.user.name || "Admin",
      reason
    });
    res.json({ success: true, report });
  } catch (err) {
    console.error("POST /admin/business/facilities/:id/reconcile-invariants error:", err);
    res.status(500).json({ error: "reconciliation_failed", message: err.message });
  }
});

/**
 * Admin reversal of a repayment with full audit trail
 */
router.post("/admin/business/facilities/reversal/:transactionId", auth, requirePermission("customers"), async (req, res) => {
  try {
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: "reason_required", message: "Audit reason is required for reversal." });
    }
    const result = await reverseBusinessRepayment({
      transactionId: req.params.transactionId,
      adminId: req.user.id,
      adminName: req.user.name || "Admin",
      reason
    });
    res.json({ success: true, message: "repayment_reversed_successfully", result });
  } catch (err) {
    console.error("POST /admin/business/facilities/reversal/:transactionId error:", err);
    res.status(400).json({ error: "reversal_failed", message: err.message });
  }
});

// ==========================================
// AUTOPAY WEBHOOK ENDPOINT
// Public webhook with cryptographic HMAC verification
// ==========================================
router.post("/webhook/autopay", async (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];
    const payload = req.rawBody || JSON.stringify(req.body);

    const isValid = verifyAutoPayWebhookSignature(payload, signature);
    if (!isValid) {
      console.warn("[AutoPayWebhook] ⚠️ Invalid webhook signature received");
      return res.status(400).json({ error: "invalid_webhook_signature" });
    }

    const event = req.body;
    const result = await handleAutoPayWebhookEvent(event);

    res.json({ received: true, result });
  } catch (err) {
    console.error("POST /webhook/autopay error:", err);
    res.status(500).json({ error: "webhook_processing_failed", message: err.message });
  }
});

export default router;
