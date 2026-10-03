import mongoose from "mongoose";
import Customer from "../models/Customer.js";
import CreditLedger from "../models/CreditLedger.js";
import CreditRepayment from "../models/CreditRepayment.js";
import AuditLog from "../models/AuditLog.js";

/**
 * Atomically deducts credit for an order checkout
 * Guarantees race-condition safety by using atomic findOneAndUpdate with condition
 */
export async function deductCreditForOrder({ customerId, orderId, orderTotal, customerName }) {
  const amount = Number(orderTotal);
  if (!amount || amount <= 0) {
    throw new Error("Invalid order total for credit deduction");
  }

  // Atomic condition: retailer must have isCreditEnabled = true and availableCredit >= amount
  const customer = await Customer.findOneAndUpdate(
    {
      _id: customerId,
      isCreditEnabled: true,
      availableCredit: { $gte: amount }
    },
    {
      $inc: {
        availableCredit: -amount,
        usedCredit: amount,
        outstandingBalance: amount
      }
    },
    { new: false } // return document before update to record exact before balance
  );

  if (!customer) {
    // Determine why it failed
    const current = await Customer.findById(customerId);
    if (!current) throw new Error("Retailer not found");
    if (!current.isCreditEnabled) throw new Error("Credit facility is not enabled for this retailer");
    if (current.availableCredit < amount) {
      throw new Error(`Insufficient credit. Available: ₹${current.availableCredit.toFixed(2)}, Required: ₹${amount.toFixed(2)}`);
    }
    throw new Error("Unable to deduct credit due to concurrent transaction");
  }

  const balanceBefore = Number(customer.availableCredit || 0);
  const balanceAfter = Number((balanceBefore - amount).toFixed(2));
  const outstandingBefore = Number(customer.outstandingBalance || 0);
  const outstandingAfter = Number((outstandingBefore + amount).toFixed(2));

  // Record immutable credit ledger entry
  const ledgerDoc = await CreditLedger.create({
    retailerId: customer._id,
    amount,
    type: "CREDIT_USED",
    referenceId: String(orderId),
    referenceType: "ORDER",
    balanceBefore,
    balanceAfter,
    outstandingBefore,
    outstandingAfter,
    reason: `Credit purchase for Order #${orderId}`,
    createdBy: String(customer._id),
    createdByName: customerName || customer.name || "Retailer"
  });

  return { customer, ledger: ledgerDoc };
}

/**
 * Reverses credit deduction (e.g. if order failed to complete after credit reservation)
 */
export async function reverseCreditForOrder({ customerId, orderId, orderTotal, reason }) {
  const amount = Number(orderTotal);
  if (!amount || amount <= 0) return;

  const customer = await Customer.findOneAndUpdate(
    { _id: customerId },
    {
      $inc: {
        availableCredit: amount,
        usedCredit: -amount,
        outstandingBalance: -amount
      }
    },
    { new: false }
  );

  if (!customer) return;

  const balanceBefore = Number(customer.availableCredit || 0);
  const balanceAfter = Number((balanceBefore + amount).toFixed(2));
  const outstandingBefore = Number(customer.outstandingBalance || 0);
  const outstandingAfter = Math.max(0, Number((outstandingBefore - amount).toFixed(2)));

  await CreditLedger.create({
    retailerId: customer._id,
    amount,
    type: "REVERSAL",
    referenceId: String(orderId),
    referenceType: "ORDER",
    balanceBefore,
    balanceAfter,
    outstandingBefore,
    outstandingAfter,
    reason: reason || `Credit reversal for Order #${orderId}`,
    createdBy: "SYSTEM",
    createdByName: "System Reversal"
  });
}

/**
 * Idempotently processes a successful Razorpay credit repayment
 */
export async function processSuccessfulRepayment({ razorpayOrderId, repaymentId, paymentId, source }) {
  const query = razorpayOrderId ? { razorpayOrderId } : { _id: repaymentId };
  const repayment = await CreditRepayment.findOne(query);

  if (!repayment) {
    throw new Error("Repayment record not found");
  }

  // Idempotency check: if already SUCCESS, return immediately
  if (repayment.status === "SUCCESS") {
    return { repayment, alreadyProcessed: true };
  }

  // Atomically lock repayment from PENDING to avoid race conditions
  const lockedRepayment = await CreditRepayment.findOneAndUpdate(
    { _id: repayment._id, status: "PAYMENT_PENDING" },
    {
      $set: {
        status: "SUCCESS",
        razorpayPaymentId: paymentId || repayment.razorpayPaymentId || "",
        verifiedAt: new Date(),
        verifiedBy: source || "SYSTEM"
      }
    },
    { new: true }
  );

  if (!lockedRepayment) {
    // Already processed by another concurrent request
    const fresh = await CreditRepayment.findById(repayment._id);
    return { repayment: fresh, alreadyProcessed: true };
  }

  const amount = Number(lockedRepayment.amount);

  // Update customer credit balances
  const customer = await Customer.findById(lockedRepayment.retailerId);
  if (!customer) {
    throw new Error("Customer not found for repayment");
  }

  const balanceBefore = Number(customer.availableCredit || 0);
  const outstandingBefore = Number(customer.outstandingBalance || 0);
  const limit = Number(customer.creditLimit || 0);

  // Available credit increases up to creditLimit
  const newAvailable = Math.min(limit, Number((balanceBefore + amount).toFixed(2)));
  const newOutstanding = Math.max(0, Number((outstandingBefore - amount).toFixed(2)));
  const newUsed = Math.max(0, Number(((customer.usedCredit || 0) - amount).toFixed(2)));

  customer.availableCredit = newAvailable;
  customer.outstandingBalance = newOutstanding;
  customer.usedCredit = newUsed;
  await customer.save();

  // Immutable ledger entry
  const ledgerDoc = await CreditLedger.create({
    retailerId: customer._id,
    amount,
    type: "CREDIT_REPAID",
    referenceId: String(lockedRepayment._id),
    referenceType: "REPAYMENT",
    balanceBefore,
    balanceAfter: newAvailable,
    outstandingBefore,
    outstandingAfter: newOutstanding,
    reason: `Repayment received via Razorpay (${paymentId || lockedRepayment.razorpayOrderId})`,
    createdBy: String(customer._id),
    createdByName: customer.name || "Retailer"
  });

  lockedRepayment.ledgerTxnId = ledgerDoc._id;
  await lockedRepayment.save();

  // Audit log
  try {
    await AuditLog.create({
      actorId: String(customer._id),
      actorRole: "customer",
      type: "CREDIT_REPAYMENT",
      entityType: "CREDIT_REPAYMENT",
      entityId: lockedRepayment._id.toString(),
      note: `Online repayment of ₹${amount} completed via Razorpay`,
      before: { availableCredit: balanceBefore, outstandingBalance: outstandingBefore },
      after: { availableCredit: newAvailable, outstandingBalance: newOutstanding }
    });
  } catch (err) {
    console.error("Audit log error:", err);
  }

  return { repayment: lockedRepayment, ledger: ledgerDoc, customer };
}

/**
 * Admin verifies a Bank Transfer credit repayment
 */
export async function verifyBankTransferRepayment({ repaymentId, adminId, adminName, notes }) {
  const repayment = await CreditRepayment.findById(repaymentId);
  if (!repayment) throw new Error("Repayment record not found");
  if (repayment.status !== "PENDING_VERIFICATION") {
    throw new Error(`Cannot verify repayment with status: ${repayment.status}`);
  }

  const customer = await Customer.findById(repayment.retailerId);
  if (!customer) throw new Error("Retailer not found");

  const amount = Number(repayment.amount);
  const balanceBefore = Number(customer.availableCredit || 0);
  const outstandingBefore = Number(customer.outstandingBalance || 0);
  const limit = Number(customer.creditLimit || 0);

  const newAvailable = Math.min(limit, Number((balanceBefore + amount).toFixed(2)));
  const newOutstanding = Math.max(0, Number((outstandingBefore - amount).toFixed(2)));
  const newUsed = Math.max(0, Number(((customer.usedCredit || 0) - amount).toFixed(2)));

  customer.availableCredit = newAvailable;
  customer.outstandingBalance = newOutstanding;
  customer.usedCredit = newUsed;
  await customer.save();

  // Ledger entry
  const ledgerDoc = await CreditLedger.create({
    retailerId: customer._id,
    amount,
    type: "CREDIT_REPAID",
    referenceId: String(repayment._id),
    referenceType: "REPAYMENT",
    balanceBefore,
    balanceAfter: newAvailable,
    outstandingBefore,
    outstandingAfter: newOutstanding,
    reason: `Bank Transfer repayment verified by Admin: ${notes || repayment.bankTransferDetails?.utr || ""}`.trim(),
    createdBy: String(adminId),
    createdByName: adminName || "Admin"
  });

  repayment.status = "SUCCESS";
  repayment.verifiedBy = String(adminId);
  repayment.verifiedAt = new Date();
  repayment.ledgerTxnId = ledgerDoc._id;
  await repayment.save();

  // Audit log
  await AuditLog.create({
    actorId: String(adminId),
    actorRole: "admin",
    type: "CREDIT_REPAYMENT_APPROVAL",
    entityType: "CREDIT_REPAYMENT",
    entityId: repayment._id.toString(),
    note: `Bank transfer repayment of ₹${amount} approved by ${adminName || 'Admin'}. UTR: ${repayment.bankTransferDetails?.utr || 'N/A'}. Notes: ${notes || ''}`,
    before: { availableCredit: balanceBefore, outstandingBalance: outstandingBefore },
    after: { availableCredit: newAvailable, outstandingBalance: newOutstanding }
  });

  return { repayment, ledger: ledgerDoc, customer };
}

/**
 * Admin rejects a Bank Transfer credit repayment
 */
export async function rejectBankTransferRepayment({ repaymentId, adminId, adminName, reason }) {
  if (!reason || !reason.trim()) {
    throw new Error("Rejection reason is required");
  }

  const repayment = await CreditRepayment.findById(repaymentId);
  if (!repayment) throw new Error("Repayment record not found");
  if (repayment.status !== "PENDING_VERIFICATION") {
    throw new Error(`Cannot reject repayment with status: ${repayment.status}`);
  }

  repayment.status = "REJECTED";
  repayment.rejectionReason = reason.trim();
  repayment.verifiedBy = String(adminId);
  repayment.verifiedAt = new Date();
  await repayment.save();

  await AuditLog.create({
    actorId: String(adminId),
    actorRole: "admin",
    type: "CREDIT_REPAYMENT_REJECTION",
    entityType: "CREDIT_REPAYMENT",
    entityId: repayment._id.toString(),
    note: `Bank transfer repayment of ₹${repayment.amount} rejected. Reason: ${reason.trim()}`
  });

  return repayment;
}

/**
 * Admin manually adjusts retailer credit (INCREASE or DECREASE)
 */
export async function adjustRetailerCredit({ retailerId, adminId, adminName, amount, type, reason }) {
  if (!amount || Number(amount) <= 0) throw new Error("Invalid adjustment amount");
  if (!reason || !reason.trim()) throw new Error("Audit reason is required for credit adjustment");

  const customer = await Customer.findById(retailerId);
  if (!customer) throw new Error("Retailer not found");
  if (!customer.isCreditEnabled) throw new Error("Credit facility is not enabled for this retailer");

  const adjAmount = Number(amount);
  const balanceBefore = Number(customer.availableCredit || 0);
  const outstandingBefore = Number(customer.outstandingBalance || 0);
  const limitBefore = Number(customer.creditLimit || 0);

  let balanceAfter = balanceBefore;
  let outstandingAfter = outstandingBefore;

  if (type === "INCREASE") {
    balanceAfter = Number((balanceBefore + adjAmount).toFixed(2));
    // Also increase credit limit if available exceeds current limit
    if (balanceAfter > customer.creditLimit) {
      customer.creditLimit = balanceAfter;
    }
    customer.availableCredit = balanceAfter;
  } else if (type === "DECREASE") {
    if (adjAmount > balanceBefore) {
      throw new Error(`Cannot decrease more than available credit (Available: ₹${balanceBefore})`);
    }
    balanceAfter = Number((balanceBefore - adjAmount).toFixed(2));
    customer.availableCredit = balanceAfter;
  } else {
    throw new Error("Adjustment type must be INCREASE or DECREASE");
  }

  await customer.save();

  const ledgerDoc = await CreditLedger.create({
    retailerId: customer._id,
    amount: adjAmount,
    type: "CREDIT_ADJUSTMENT",
    referenceId: "",
    referenceType: "ADMIN_ADJUSTMENT",
    balanceBefore,
    balanceAfter,
    outstandingBefore,
    outstandingAfter,
    reason: `Manual Adjustment [${type}]: ${reason.trim()}`,
    createdBy: String(adminId),
    createdByName: adminName || "Admin"
  });

  await AuditLog.create({
    actorId: String(adminId),
    actorRole: "admin",
    type: "CREDIT_ADJUSTMENT",
    entityType: "CUSTOMER",
    entityId: customer._id.toString(),
    note: `Manual credit adjustment of ₹${adjAmount} (${type}). Reason: ${reason.trim()}`,
    before: { availableCredit: balanceBefore, creditLimit: limitBefore },
    after: { availableCredit: balanceAfter, creditLimit: customer.creditLimit }
  });

  return { customer, ledger: ledgerDoc };
}

/**
 * Admin toggles credit on/off or sets initial limit
 */
export async function toggleRetailerCredit({ retailerId, adminId, adminName, isCreditEnabled, creditLimit, reason }) {
  if (!reason || !reason.trim()) throw new Error("Audit reason is required");

  const customer = await Customer.findById(retailerId);
  if (!customer) throw new Error("Retailer not found");

  const beforeEnabled = customer.isCreditEnabled;
  const beforeLimit = customer.creditLimit || 0;
  const beforeAvailable = customer.availableCredit || 0;

  customer.isCreditEnabled = Boolean(isCreditEnabled);

  if (customer.isCreditEnabled) {
    if (creditLimit !== undefined && creditLimit !== null) {
      const numLimit = Math.max(0, Number(creditLimit));
      const diff = numLimit - (customer.creditLimit || 0);
      customer.creditLimit = numLimit;
      customer.availableCredit = Math.max(0, Number(((customer.availableCredit || 0) + diff).toFixed(2)));
    }
  }

  await customer.save();

  const ledgerDoc = await CreditLedger.create({
    retailerId: customer._id,
    amount: customer.creditLimit,
    type: beforeEnabled ? "CREDIT_ADJUSTMENT" : "CREDIT_GRANTED",
    referenceId: "",
    referenceType: "INITIAL_SETUP",
    balanceBefore: beforeAvailable,
    balanceAfter: customer.availableCredit,
    outstandingBefore: customer.outstandingBalance || 0,
    outstandingAfter: customer.outstandingBalance || 0,
    reason: `Credit ${customer.isCreditEnabled ? "Enabled/Updated" : "Disabled"}: ${reason.trim()}`,
    createdBy: String(adminId),
    createdByName: adminName || "Admin"
  });

  await AuditLog.create({
    actorId: String(adminId),
    actorRole: "admin",
    type: "CREDIT_STATUS_UPDATE",
    entityType: "CUSTOMER",
    entityId: customer._id.toString(),
    note: `Credit facility set to ${customer.isCreditEnabled ? "ENABLED (Limit: ₹" + customer.creditLimit + ")" : "DISABLED"}. Reason: ${reason.trim()}`,
    before: { isCreditEnabled: beforeEnabled, creditLimit: beforeLimit, availableCredit: beforeAvailable },
    after: { isCreditEnabled: customer.isCreditEnabled, creditLimit: customer.creditLimit, availableCredit: customer.availableCredit }
  });

  return { customer, ledger: ledgerDoc };
}
