import mongoose from "mongoose";
import Customer from "../models/Customer.js";
import AuditLog from "../models/AuditLog.js";
import CreditProductSettings from "../models/CreditProductSettings.js";
import BusinessCreditApplication from "../models/BusinessCreditApplication.js";
import BusinessCreditFacility from "../models/BusinessCreditFacility.js";
import BusinessCreditSchedule from "../models/BusinessCreditSchedule.js";
import BusinessCreditTransaction from "../models/BusinessCreditTransaction.js";
import {
  calculateAccruedInterest,
  calculateDailyCompoundedInterest,
  generateRepaymentSchedule,
  calculateProcessingFee,
  getBusinessDateString
} from "./interest.service.js";

/**
 * Ensures and returns singleton Business Credit settings
 */
export async function getProductSettings() {
  let settings = await CreditProductSettings.findOne({ productKey: "BUSINESS_CREDIT_LINE" });
  if (!settings) {
    settings = await CreditProductSettings.create({
      productKey: "BUSINESS_CREDIT_LINE",
      productName: "Click2Kart Business Credit Line",
      isEnabled: true,
      isApplicationAcceptanceEnabled: true,
      minAmount: 10000,
      maxAmount: 500000,
      minTenureMonths: 1,
      defaultTenureMonths: 3,
      maxTenureMonths: 5,
      permittedTenures: [1, 2, 3, 4, 5],
      repaymentFrequency: "WEEKLY",
      interestRatePerAnnum: 18.0,
      interestMethod: "DAILY_COMPOUNDING",
      dayCountConvention: "ACTUAL_365",
      processingFeeType: "PERCENTAGE",
      processingFeeValue: 2.0,
      processingFeeGstPercent: 18.0,
      deductFeeFromDisbursement: true,
      gracePeriodDays: 3,
      autoPayEnabled: false,
      latePenaltyRatePerAnnum: 24.0
    });
  }
  return settings;
}

/**
 * Checks if a retailer is eligible to apply for Business Credit Line
 */
export async function checkRetailerEligibility(retailerId) {
  const customer = await Customer.findById(retailerId).select(
    "name phone email isCreditEnabled creditLimit availableCredit usedCredit outstandingBalance isKycComplete kyc"
  );

  if (!customer) {
    return { eligible: false, reasons: ["Retailer account not found."] };
  }

  const settings = await getProductSettings();
  const reasons = [];

  if (!settings.isEnabled) {
    reasons.push("Business Credit Line product is temporarily inactive.");
  }
  if (!settings.isApplicationAcceptanceEnabled) {
    reasons.push("New applications are temporarily paused by administration.");
  }

  // Mandatory rule 1: Retailer must have an active Trade Credit Line
  if (!customer.isCreditEnabled) {
    reasons.push("An active Trade Credit Line is required before applying for a Business Credit Line.");
  }

  // Mandatory rule 2: Must be KYC verified
  const isKycVerified = Boolean(customer.isKycComplete || customer.kyc?.status === "VERIFIED");
  if (!isKycVerified) {
    reasons.push("Your business KYC must be fully verified and approved.");
  }

  // Rule 3: Check existing pending applications
  const activeApp = await BusinessCreditApplication.findOne({
    retailerId: customer._id,
    status: { $in: ["SUBMITTED", "UNDER_REVIEW", "APPROVED", "OFFER_ACCEPTED", "DISBURSEMENT_PENDING"] }
  });

  if (activeApp) {
    reasons.push(`You already have an active application (${activeApp.applicationNumber}) with status '${activeApp.status}'.`);
  }

  // Rule 4: Check if there's already an active open business facility
  const activeFacility = await BusinessCreditFacility.findOne({
    retailerId: customer._id,
    status: { $in: ["ACTIVE", "OVERDUE"] }
  });

  return {
    eligible: reasons.length === 0,
    isEligible: reasons.length === 0,
    reasons,
    customer: {
      _id: customer._id,
      name: customer.name,
      isCreditEnabled: customer.isCreditEnabled,
      tradeCreditLimit: customer.creditLimit,
      isKycComplete: isKycVerified
    },
    settings: {
      minAmount: settings.minAmount,
      maxAmount: settings.maxAmount,
      permittedTenures: settings.permittedTenures && settings.permittedTenures.length > 0 ? settings.permittedTenures : [1, 2, 3, 4, 5],
      defaultTenureMonths: settings.defaultTenureMonths || 3,
      maxTenureMonths: settings.maxTenureMonths || 5,
      interestRatePerAnnum: settings.interestRatePerAnnum,
      interestMethod: settings.interestMethod,
      repaymentFrequency: settings.repaymentFrequency,
      processingFeeType: settings.processingFeeType,
      processingFeeValue: settings.processingFeeValue,
      processingFeeGstPercent: settings.processingFeeGstPercent
    },
    activeApplication: activeApp || null,
    activeFacility: activeFacility || null
  };
}

/**
 * Retailer submits a Business Credit Line application
 */
export async function submitApplication({
  retailerId,
  requestedAmount,
  purpose,
  requestedTenureMonths,
  businessDetails,
  supportingDocuments
}) {
  const eligibility = await checkRetailerEligibility(retailerId);
  if (!eligibility.eligible) {
    throw new Error(`Ineligible to apply: ${eligibility.reasons.join(" ")}`);
  }

  const settings = await getProductSettings();
  const amount = Number(requestedAmount);
  const tenure = parseInt(requestedTenureMonths, 10);

  if (!amount || amount < settings.minAmount || amount > settings.maxAmount) {
    throw new Error(`Requested amount must be between ₹${settings.minAmount.toLocaleString("en-IN")} and ₹${settings.maxAmount.toLocaleString("en-IN")}.`);
  }

  // Permitted tenure validation
  const allowedTenures = settings.permittedTenures && settings.permittedTenures.length > 0
    ? settings.permittedTenures
    : [1, 2, 3, 4, 5];
  if (!allowedTenures.includes(tenure)) {
    throw new Error(`Tenure must be one of the permitted durations: ${allowedTenures.join(", ")} months (Received: ${tenure}).`);
  }

  if (!purpose || !String(purpose).trim()) {
    throw new Error("Permitted business purpose is required.");
  }

  const dateStr = getBusinessDateString().replace(/-/g, "");
  const rand = Math.floor(1000 + Math.random() * 9000);
  const applicationNumber = `BCA-${dateStr}-${rand}`;

  const application = await BusinessCreditApplication.create({
    applicationNumber,
    retailerId,
    requestedAmount: amount,
    purpose: String(purpose).trim(),
    requestedTenureMonths: tenure,
    businessDetails: businessDetails || {},
    supportingDocuments: supportingDocuments || [],
    status: "SUBMITTED"
  });

  return application;
}

/**
 * Admin reviews an application (Approve, Partial Approve, Request Info, Reject)
 */
export async function adminReviewApplication({
  applicationId,
  adminId,
  adminName,
  action,
  approvedAmount,
  approvedTenureMonths,
  interestRate,
  processingFeeType,
  processingFeeValue,
  repaymentFrequency,
  adminNotes,
  rejectionReason
}) {
  const application = await BusinessCreditApplication.findById(applicationId);
  if (!application) throw new Error("Application not found.");

  let normalizedAction = String(action || "").toUpperCase().trim();
  if (normalizedAction === "APPROVE") normalizedAction = "APPROVED";
  if (normalizedAction === "PARTIAL") normalizedAction = "PARTIAL_APPROVE";

  if (!["APPROVED", "PARTIAL_APPROVE", "REQUEST_INFO", "REJECT"].includes(normalizedAction)) {
    throw new Error(`Invalid review action: ${action}. Expected APPROVE, PARTIAL_APPROVE, REQUEST_INFO, or REJECT.`);
  }

  const settings = await getProductSettings();

  if (normalizedAction === "REJECT") {
    if (!rejectionReason || !rejectionReason.trim()) {
      throw new Error("Rejection reason is required.");
    }
    application.status = "REJECTED";
    application.rejectionReason = rejectionReason.trim();
    application.adminNotes = adminNotes || application.adminNotes;
    application.reviewedBy = adminId;
    application.reviewedByName = adminName || "Admin";
    application.reviewedAt = new Date();
    await application.save();

    await AuditLog.create({
      actorId: String(adminId),
      actorRole: "admin",
      type: "BUSINESS_CREDIT_REVIEW",
      entityType: "BUSINESS_CREDIT_APPLICATION",
      entityId: application._id.toString(),
      note: `Application ${application.applicationNumber} REJECTED. Reason: ${rejectionReason.trim()}`
    });

    return application;
  }

  if (normalizedAction === "REQUEST_INFO") {
    application.status = "ADDITIONAL_INFO_REQUIRED";
    application.adminNotes = adminNotes || "Additional documentation required.";
    application.reviewedBy = adminId;
    application.reviewedByName = adminName || "Admin";
    application.reviewedAt = new Date();
    await application.save();

    return application;
  }

  // APPROVE or PARTIAL_APPROVE
  const finalAmount = Number(approvedAmount || application.requestedAmount);
  const finalTenure = parseInt(approvedTenureMonths || application.requestedTenureMonths, 10);
  const rate = Number(interestRate !== undefined ? interestRate : settings.interestRatePerAnnum);
  const freq = repaymentFrequency || settings.repaymentFrequency || "WEEKLY";

  // Permitted tenure validation
  const allowedTenures = settings.permittedTenures && settings.permittedTenures.length > 0
    ? settings.permittedTenures
    : [1, 2, 3, 4, 5];
  if (!allowedTenures.includes(finalTenure)) {
    throw new Error(`Approved tenure must be one of the permitted durations: ${allowedTenures.join(", ")} months (Received: ${finalTenure}).`);
  }

  if (finalAmount <= 0 || finalAmount > settings.maxAmount) {
    throw new Error(`Approved amount must be between ₹1 and ₹${settings.maxAmount.toLocaleString("en-IN")}.`);
  }

  // Calculate fees and amortization schedule snapshot
  const feeCalc = calculateProcessingFee({
    amount: finalAmount,
    feeType: processingFeeType || settings.processingFeeType,
    feeValue: processingFeeValue !== undefined ? processingFeeValue : settings.processingFeeValue,
    gstPercent: settings.processingFeeGstPercent
  });

  const amort = generateRepaymentSchedule({
    principal: finalAmount,
    annualRatePercent: rate,
    tenureMonths: finalTenure,
    frequency: freq,
    startDate: new Date(),
    dayCountConvention: settings.dayCountConvention,
    permittedTenures: allowedTenures
  });

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // Offer valid for 7 days

  application.status = "APPROVED";
  application.reviewedBy = adminId;
  application.reviewedByName = adminName || "Admin";
  application.reviewedAt = new Date();
  application.adminNotes = adminNotes || (action === "PARTIAL_APPROVE" ? "Approved with adjusted financial terms" : "Approved by Admin");
  application.approvedOffer = {
    approvedAmount: finalAmount,
    approvedTenureMonths: finalTenure,
    interestRatePerAnnum: rate,
    interestMethod: settings.interestMethod,
    repaymentFrequency: freq,
    processingFeeAmount: feeCalc.processingFee,
    processingFeeGst: feeCalc.gst,
    totalProcessingFee: feeCalc.totalFee,
    netDisbursementAmount: feeCalc.netDisbursement,
    estimatedTotalInterest: amort.totalInterest,
    estimatedTotalPayable: amort.totalPayable,
    instalmentEstimate: amort.estimatedInstalment,
    totalInstalments: amort.numInstalments,
    offerExpiresAt: expiresAt,
    agreementText: `Business Credit Facility Agreement for ₹${finalAmount.toLocaleString("en-IN")} at ${rate}% p.a. for ${finalTenure} months. Repayment Frequency: ${freq}. Total Instalments: ${amort.numInstalments}.`,
    agreementAccepted: false
  };

  await application.save();

  await AuditLog.create({
    actorId: String(adminId),
    actorRole: "admin",
    type: "BUSINESS_CREDIT_APPROVAL",
    entityType: "BUSINESS_CREDIT_APPLICATION",
    entityId: application._id.toString(),
    note: `Application ${application.applicationNumber} APPROVED for ₹${finalAmount} over ${finalTenure} months at ${rate}% p.a.`
  });

  return application;
}

/**
 * Admin proactively grants a Business Credit Line offer to an eligible retailer
 */
export async function adminProactiveGrant({
  retailerId,
  adminId,
  adminName,
  approvedAmount,
  approvedTenureMonths,
  interestRate,
  processingFeeValue,
  repaymentFrequency,
  reason,
  adminNotes
}) {
  const customer = await Customer.findById(retailerId);
  if (!customer) throw new Error("Retailer not found.");
  if (!customer.isCreditEnabled) {
    throw new Error("Retailer must have an active Trade Credit Line before receiving a Business Credit Line.");
  }
  if (!reason || !reason.trim()) {
    throw new Error("Audit reason is required for proactive credit grant.");
  }

  const settings = await getProductSettings();
  const finalAmount = Number(approvedAmount || 50000);
  const finalTenure = parseInt(approvedTenureMonths || 3, 10);
  const rate = Number(interestRate !== undefined ? interestRate : settings.interestRatePerAnnum);
  const freq = repaymentFrequency || "WEEKLY";

  // Permitted tenure validation
  const allowedTenures = settings.permittedTenures && settings.permittedTenures.length > 0
    ? settings.permittedTenures
    : [1, 2, 3, 4, 5];
  if (!allowedTenures.includes(finalTenure)) {
    throw new Error(`Tenure must be one of the permitted durations: ${allowedTenures.join(", ")} months (Received: ${finalTenure}).`);
  }

  const feeCalc = calculateProcessingFee({
    amount: finalAmount,
    feeType: settings.processingFeeType,
    feeValue: processingFeeValue !== undefined ? processingFeeValue : settings.processingFeeValue,
    gstPercent: settings.processingFeeGstPercent
  });

  const amort = generateRepaymentSchedule({
    principal: finalAmount,
    annualRatePercent: rate,
    tenureMonths: finalTenure,
    frequency: freq,
    startDate: new Date(),
    dayCountConvention: settings.dayCountConvention,
    permittedTenures: allowedTenures
  });

  const dateStr = getBusinessDateString().replace(/-/g, "");
  const rand = Math.floor(1000 + Math.random() * 9000);
  const applicationNumber = `BCA-PROACTIVE-${dateStr}-${rand}`;

  const application = await BusinessCreditApplication.create({
    applicationNumber,
    retailerId: customer._id,
    requestedAmount: finalAmount,
    purpose: "Proactive Working Capital Line Granted by Admin",
    requestedTenureMonths: finalTenure,
    isProactiveGrant: true,
    status: "APPROVED",
    reviewedBy: adminId,
    reviewedByName: adminName || "Admin",
    reviewedAt: new Date(),
    adminNotes: `Proactive Grant: ${reason.trim()}. ${adminNotes || ""}`.trim(),
    approvedOffer: {
      approvedAmount: finalAmount,
      approvedTenureMonths: finalTenure,
      interestRatePerAnnum: rate,
      interestMethod: settings.interestMethod,
      repaymentFrequency: freq,
      processingFeeAmount: feeCalc.processingFee,
      processingFeeGst: feeCalc.gst,
      totalProcessingFee: feeCalc.totalFee,
      netDisbursementAmount: feeCalc.netDisbursement,
      estimatedTotalInterest: amort.totalInterest,
      estimatedTotalPayable: amort.totalPayable,
      instalmentEstimate: amort.estimatedInstalment,
      totalInstalments: amort.numInstalments,
      offerExpiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days
      agreementText: `Proactive Business Credit Agreement for ₹${finalAmount.toLocaleString("en-IN")} at ${rate}% p.a. for ${finalTenure} months. Repayment: ${freq}.`,
      agreementAccepted: false
    }
  });

  await AuditLog.create({
    actorId: String(adminId),
    actorRole: "admin",
    type: "BUSINESS_CREDIT_PROACTIVE_GRANT",
    entityType: "BUSINESS_CREDIT_APPLICATION",
    entityId: application._id.toString(),
    note: `Proactively created Business Credit Line for retailer ${customer.name} (₹${finalAmount}, ${finalTenure}m). Reason: ${reason.trim()}`
  });

  return application;
}

/**
 * Retailer reviews and accepts the approved credit offer
 */
export async function acceptOffer({ applicationId, retailerId, ipAddress, bankDetails }) {
  const application = await BusinessCreditApplication.findOne({
    _id: applicationId,
    retailerId
  });

  if (!application) throw new Error("Application not found or unauthorized.");
  if (application.status !== "APPROVED") {
    throw new Error(`Cannot accept offer with status '${application.status}'.`);
  }

  if (application.approvedOffer?.offerExpiresAt && new Date() > application.approvedOffer.offerExpiresAt) {
    throw new Error("This credit offer has expired. Please contact administration.");
  }

  // Update retailer's disbursement bank details if provided
  if (bankDetails && typeof bankDetails === "object") {
    if (!application.businessDetails) application.businessDetails = {};
    if (!application.businessDetails.bankDetails) application.businessDetails.bankDetails = {};

    if (bankDetails.accountHolder) {
      application.businessDetails.bankDetails.accountHolder = String(bankDetails.accountHolder).trim();
    }
    if (bankDetails.accountNumber) {
      application.businessDetails.bankDetails.accountNumber = String(bankDetails.accountNumber).trim();
    }
    if (bankDetails.ifsc) {
      application.businessDetails.bankDetails.ifsc = String(bankDetails.ifsc).trim().toUpperCase();
    }
    if (bankDetails.bankName) {
      application.businessDetails.bankDetails.bankName = String(bankDetails.bankName).trim();
    }
    if (bankDetails.branch) {
      application.businessDetails.bankDetails.branch = String(bankDetails.branch).trim();
    }
    if (bankDetails.accountType) {
      application.businessDetails.bankDetails.accountType = String(bankDetails.accountType).trim();
    }
  }

  application.status = "OFFER_ACCEPTED";
  application.approvedOffer.agreementAccepted = true;
  application.approvedOffer.offerAcceptedAt = new Date();
  application.approvedOffer.offerAcceptedIp = String(ipAddress || "");
  await application.save();

  // Moves to disbursement pending
  application.status = "DISBURSEMENT_PENDING";
  await application.save();

  return application;
}

/**
 * Confirms disbursement of funds and activates the Business Credit Facility
 */
export async function confirmDisbursement({
  applicationId,
  adminId,
  adminName,
  method = "BANK_TRANSFER",
  utr,
  accountHolder,
  accountNumber,
  ifsc,
  bankName,
  notes,
  disbursementDate
}) {
  const application = await BusinessCreditApplication.findById(applicationId);
  if (!application) throw new Error("Application not found.");
  if (!["OFFER_ACCEPTED", "DISBURSEMENT_PENDING"].includes(application.status)) {
    throw new Error(`Cannot disburse funds for application in status '${application.status}'.`);
  }

  const offer = application.approvedOffer;
  if (!offer || !offer.approvedAmount || offer.approvedAmount <= 0) {
    throw new Error("Application has no valid approved offer terms.");
  }

  const settings = await getProductSettings();
  const dateStr = getBusinessDateString().replace(/-/g, "");
  const rand = Math.floor(1000 + Math.random() * 9000);
  const facilityNumber = `BCF-${dateStr}-${rand}`;
  const disbDate = disbursementDate ? new Date(disbursementDate) : new Date();

  // Generate official repayment schedule
  const amort = generateRepaymentSchedule({
    principal: offer.approvedAmount,
    annualRatePercent: offer.interestRatePerAnnum,
    tenureMonths: offer.approvedTenureMonths,
    frequency: offer.repaymentFrequency || "WEEKLY",
    startDate: disbDate,
    dayCountConvention: settings.dayCountConvention,
    permittedTenures: settings.permittedTenures && settings.permittedTenures.length > 0 ? settings.permittedTenures : [1, 2, 3, 4, 5]
  });

  // Create BusinessCreditFacility
  const facility = await BusinessCreditFacility.create({
    facilityNumber,
    applicationId: application._id,
    retailerId: application.retailerId,
    status: "ACTIVE",
    sanctionedLimit: offer.approvedAmount,
    disbursedAmount: offer.approvedAmount,
    disbursedAt: disbDate,
    tenureMonths: offer.approvedTenureMonths,
    repaymentFrequency: offer.repaymentFrequency || "WEEKLY",
    totalInstalments: amort.numInstalments,
    interestRatePerAnnum: offer.interestRatePerAnnum,
    interestMethod: offer.interestMethod || "DAILY_COMPOUNDING",
    dayCountConvention: settings.dayCountConvention,
    processingFeePaid: offer.totalProcessingFee || 0,
    principalOutstanding: offer.approvedAmount,
    interestAccruedTotal: 0,
    interestOutstanding: 0,
    interestPaidTotal: 0,
    principalPaidTotal: 0,
    totalPaid: 0,
    overdueAmount: 0,
    totalPayable: offer.approvedAmount,
    lastInterestAccrualDate: disbDate,
    disbursementDetails: {
      method: method || "BANK_TRANSFER",
      utr: utr || "",
      accountHolder: accountHolder || application.businessDetails?.bankDetails?.accountHolder || "",
      accountNumber: accountNumber || application.businessDetails?.bankDetails?.accountNumber || "",
      ifsc: ifsc || application.businessDetails?.bankDetails?.ifsc || "",
      bankName: bankName || application.businessDetails?.bankDetails?.bankName || "",
      confirmedAt: disbDate,
      confirmedBy: adminName || "Admin",
      notes: notes || ""
    },
    nextDueDate: amort.schedule[0]?.dueDate,
    nextDueAmount: amort.schedule[0]?.totalDue,
    maturityDate: amort.schedule[amort.schedule.length - 1]?.dueDate
  });

  // Save all schedule instalments
  const scheduleDocs = amort.schedule.map((inst) => ({
    facilityId: facility._id,
    retailerId: application.retailerId,
    instalmentNumber: inst.instalmentNumber,
    dueDate: inst.dueDate,
    principalDue: inst.principalDue,
    interestDue: inst.interestDue,
    feeDue: inst.feeDue,
    totalDue: inst.totalDue,
    status: "UPCOMING"
  }));
  await BusinessCreditSchedule.insertMany(scheduleDocs);

  // Record append-only DISBURSEMENT transaction in ledger
  await BusinessCreditTransaction.create({
    facilityId: facility._id,
    retailerId: application.retailerId,
    type: "DISBURSEMENT",
    amount: offer.approvedAmount,
    principalComponent: offer.approvedAmount,
    interestComponent: 0,
    feeComponent: 0,
    principalOutstandingBefore: 0,
    principalOutstandingAfter: offer.approvedAmount,
    interestOutstandingBefore: 0,
    interestOutstandingAfter: 0,
    totalPayableBefore: 0,
    totalPayableAfter: offer.approvedAmount,
    method: method || "BANK_TRANSFER",
    paymentDetails: {
      utr: utr || "",
      notes: `Disbursement confirmed by ${adminName || 'Admin'}. Net amount: ₹${offer.netDisbursementAmount}`
    },
    idempotencyKey: `DISB-${facility._id}`,
    reason: `Initial facility disbursement for ${facility.facilityNumber}`,
    createdBy: String(adminId),
    createdByName: adminName || "Admin"
  });

  // Update application status
  application.status = "DISBURSED";
  application.facilityId = facility._id;
  await application.save();

  await AuditLog.create({
    actorId: String(adminId),
    actorRole: "admin",
    type: "BUSINESS_CREDIT_DISBURSED",
    entityType: "BUSINESS_CREDIT_FACILITY",
    entityId: facility._id.toString(),
    note: `Disbursed ₹${offer.approvedAmount} for facility ${facility.facilityNumber}. UTR: ${utr || "N/A"}`
  });

  return { facility, application };
}

/**
 * Pure allocation engine for a repayment amount against pending schedules and facility principal
 * Allocates strictly: Fees -> Interest -> Principal -> Prepayment -> Surplus
 */
export function allocateRepayment({ pendingSchedules, principalOutstanding, amount }) {
  const numAmount = Number(amount);
  if (!numAmount || numAmount <= 0) {
    throw new Error("Invalid repayment amount. Repayment amount must be strictly positive.");
  }

  let unallocated = numAmount;
  let totalFeePaid = 0;
  let totalInterestPaid = 0;
  let totalPrincipalPaid = 0;

  // Structured allocation per instalment: Fees first -> Interest second -> Principal third
  for (const inst of pendingSchedules) {
    if (unallocated <= 0) break;

    // Remaining dues on this instalment
    const feeDueRemaining = Math.max(0, Number(((inst.feeDue || 0) - (inst.feePaid || 0)).toFixed(2)));
    const interestDueRemaining = Math.max(0, Number(((inst.interestDue || 0) - (inst.interestPaid || 0)).toFixed(2)));
    const principalDueRemaining = Math.max(0, Number(((inst.principalDue || 0) - (inst.principalPaid || 0)).toFixed(2)));

    // Allocate Fees
    let feeAlloc = 0;
    if (feeDueRemaining > 0 && unallocated > 0) {
      feeAlloc = Math.min(unallocated, feeDueRemaining);
      inst.feePaid = Number(((inst.feePaid || 0) + feeAlloc).toFixed(2));
      unallocated = Number((unallocated - feeAlloc).toFixed(2));
      totalFeePaid = Number((totalFeePaid + feeAlloc).toFixed(2));
    }

    // Allocate Interest
    let interestAlloc = 0;
    if (interestDueRemaining > 0 && unallocated > 0) {
      interestAlloc = Math.min(unallocated, interestDueRemaining);
      inst.interestPaid = Number(((inst.interestPaid || 0) + interestAlloc).toFixed(2));
      unallocated = Number((unallocated - interestAlloc).toFixed(2));
      totalInterestPaid = Number((totalInterestPaid + interestAlloc).toFixed(2));
    }

    // Allocate Principal
    let principalAlloc = 0;
    if (principalDueRemaining > 0 && unallocated > 0) {
      principalAlloc = Math.min(unallocated, principalDueRemaining);
      inst.principalPaid = Number(((inst.principalPaid || 0) + principalAlloc).toFixed(2));
      unallocated = Number((unallocated - principalAlloc).toFixed(2));
      totalPrincipalPaid = Number((totalPrincipalPaid + principalAlloc).toFixed(2));
    }

    inst.totalPaid = Number(((inst.feePaid || 0) + inst.interestPaid + inst.principalPaid).toFixed(2));

    if (inst.totalPaid >= inst.totalDue) {
      inst.status = "PAID";
      inst.paidAt = new Date();
    } else if (inst.totalPaid > 0) {
      inst.status = "PARTIALLY_PAID";
    }
  }

  // Prepay future remaining facility principal strictly up to facility.principalOutstanding
  let surplusRefundDue = 0;
  if (unallocated > 0) {
    const remainingPrincipalLimit = Math.max(0, Number((principalOutstanding - totalPrincipalPaid).toFixed(2)));
    const excessToPrincipal = Math.min(unallocated, remainingPrincipalLimit);

    totalPrincipalPaid = Number((totalPrincipalPaid + excessToPrincipal).toFixed(2));
    unallocated = Number((unallocated - excessToPrincipal).toFixed(2));

    if (unallocated > 0) {
      // Overpayment surplus: cannot reduce principal below 0
      surplusRefundDue = unallocated;
      unallocated = 0;
    }
  }

  return {
    totalFeePaid,
    totalInterestPaid,
    totalPrincipalPaid,
    surplusRefundDue
  };
}

/**
 * Processes a repayment for a Business Credit Facility
 * Strict allocation hierarchy:
 * 1. Schedule fee dues (if any)
 * 2. Schedule interest dues & accrued unbilled interest
 * 3. Schedule principal dues
 * 4. Prepayment of remaining facility principal (capped strictly at facility.principalOutstanding)
 * 5. Overpayment surplus tracked without negative balances
 * Enforces duplicate payment rejection via unique key/payment ID
 */
export async function processBusinessRepayment({
  facilityId,
  retailerId,
  amount,
  method = "RAZORPAY",
  paymentDetails = {},
  createdBy = "SYSTEM",
  createdByName = "System"
}) {
  const numAmount = Number(amount);
  if (!numAmount || numAmount <= 0) {
    throw new Error("Invalid repayment amount. Repayment amount must be strictly positive.");
  }

  const facility = await BusinessCreditFacility.findById(facilityId);
  if (!facility) throw new Error("Business credit facility not found.");
  if (retailerId && facility.retailerId.toString() !== retailerId.toString()) {
    throw new Error("Unauthorized repayment attempt.");
  }

  // 1. Idempotency & Duplicate Payment Check
  const paymentRef = paymentDetails.idempotencyKey || paymentDetails.razorpayPaymentId || paymentDetails.utr || null;
  if (paymentRef) {
    const existingTxn = await BusinessCreditTransaction.findOne({
      facilityId: facility._id,
      $or: [
        { idempotencyKey: paymentRef },
        { "paymentDetails.razorpayPaymentId": paymentRef },
        { "paymentDetails.utr": paymentRef }
      ]
    });
    if (existingTxn) {
      throw new Error(`Duplicate payment rejected. Payment reference '${paymentRef}' was already processed (Transaction ID: ${existingTxn._id}).`);
    }
  }

  // Snapshots before payment
  const principalBefore = facility.principalOutstanding;
  const interestOutstandingBefore = facility.interestOutstanding;
  const totalPayableBefore = facility.totalPayable;

  // 2. Fetch all schedules requiring payment
  const pendingSchedules = await BusinessCreditSchedule.find({
    facilityId: facility._id,
    status: { $in: ["OVERDUE", "DUE", "UPCOMING", "PARTIALLY_PAID"] }
  }).sort({ instalmentNumber: 1 });

  // 3. Structured allocation per instalment: Fees first -> Interest second -> Principal third
  const {
    totalFeePaid,
    totalInterestPaid,
    totalPrincipalPaid,
    surplusRefundDue
  } = allocateRepayment({
    pendingSchedules,
    principalOutstanding: facility.principalOutstanding,
    amount: numAmount
  });

  for (const inst of pendingSchedules) {
    if (inst.totalPaid > 0 && typeof inst.save === "function") {
      inst.paymentReference = paymentDetails.razorpayPaymentId || paymentDetails.utr || "REPAYMENT";
      await inst.save();
    }
  }

  if (surplusRefundDue > 0) {
    paymentDetails.surplusRefundDue = surplusRefundDue;
  }

  // 5. Update Facility Balances
  const unbilledInterestPaid = Math.max(0, Number((totalInterestPaid - (facility.interestOutstanding || 0)).toFixed(2)));
  facility.interestAccruedTotal = Number(((facility.interestAccruedTotal || 0) + unbilledInterestPaid).toFixed(2));
  facility.principalPaidTotal = Number(((facility.principalPaidTotal || 0) + totalPrincipalPaid).toFixed(2));
  facility.interestPaidTotal = Number(((facility.interestPaidTotal || 0) + totalInterestPaid).toFixed(2));
  const effectivePaymentAmount = Number((numAmount - surplusRefundDue).toFixed(2));
  facility.totalPaid = Number(((facility.totalPaid || 0) + effectivePaymentAmount).toFixed(2));

  facility.principalOutstanding = Math.max(0, Number((facility.principalOutstanding - totalPrincipalPaid).toFixed(2)));
  facility.interestOutstanding = Math.max(0, Number(((facility.interestOutstanding || 0) + unbilledInterestPaid - totalInterestPaid).toFixed(2)));
  facility.totalPayable = Number((facility.principalOutstanding + facility.interestOutstanding).toFixed(2));

  // Early settlement check
  if (facility.principalOutstanding <= 0 && facility.interestOutstanding <= 0) {
    facility.status = "SETTLED";
    facility.settledAt = new Date();
    facility.nextDueDate = null;
    facility.nextDueAmount = 0;
  } else {
    // Update next due instalment
    const nextInst = await BusinessCreditSchedule.findOne({
      facilityId: facility._id,
      status: { $in: ["OVERDUE", "DUE", "UPCOMING", "PARTIALLY_PAID"] }
    }).sort({ instalmentNumber: 1 });

    if (nextInst) {
      facility.nextDueDate = nextInst.dueDate;
      facility.nextDueAmount = Math.max(0, Number((nextInst.totalDue - nextInst.totalPaid).toFixed(2)));
    } else {
      facility.nextDueDate = null;
      facility.nextDueAmount = 0;
    }
  }

  await facility.save();

  // 6. Record Immutable Append-Only Ledger Entry
  const idempotencyKey = paymentDetails.idempotencyKey || paymentDetails.razorpayPaymentId || paymentDetails.utr || `REPAY-${facility._id}-${Date.now()}`;

  const txn = await BusinessCreditTransaction.create({
    facilityId: facility._id,
    retailerId: facility.retailerId,
    type: "REPAYMENT",
    amount: numAmount,
    principalComponent: totalPrincipalPaid,
    interestComponent: totalInterestPaid,
    feeComponent: totalFeePaid,
    principalOutstandingBefore,
    principalOutstandingAfter: facility.principalOutstanding,
    interestOutstandingBefore,
    interestOutstandingAfter: facility.interestOutstanding,
    totalPayableBefore,
    totalPayableAfter: facility.totalPayable,
    method,
    paymentDetails: {
      ...paymentDetails,
      surplusRefundDue
    },
    idempotencyKey,
    reason: `Repayment of ₹${numAmount} via ${method} (Principal: ₹${totalPrincipalPaid}, Interest: ₹${totalInterestPaid}${totalFeePaid > 0 ? `, Fee: ₹${totalFeePaid}` : ""}${surplusRefundDue > 0 ? `, Surplus Refund: ₹${surplusRefundDue}` : ""})`,
    createdBy: String(createdBy),
    createdByName: createdByName || "System"
  });

  return {
    facility,
    transaction: txn,
    allocation: {
      principal: totalPrincipalPaid,
      interest: totalInterestPaid,
      fee: totalFeePaid,
      surplusRefundDue
    }
  };
}

/**
 * Reverses a previously processed repayment (e.g. bounce, chargeback, or admin correction)
 * Restores balances and schedule statuses without silently rewriting history
 */
export async function reverseBusinessRepayment({
  transactionId,
  adminId,
  adminName,
  reason
}) {
  if (!reason || !String(reason).trim()) {
    throw new Error("Audit reason is required to reverse a repayment.");
  }

  const origTxn = await BusinessCreditTransaction.findById(transactionId);
  if (!origTxn) throw new Error("Transaction not found.");
  if (origTxn.type !== "REPAYMENT") {
    throw new Error(`Cannot reverse transaction of type '${origTxn.type}'. Only 'REPAYMENT' can be reversed.`);
  }

  // Check if already reversed
  const existingReversal = await BusinessCreditTransaction.findOne({
    facilityId: origTxn.facilityId,
    type: "REVERSAL",
    "paymentDetails.originalTransactionId": origTxn._id.toString()
  });
  if (existingReversal) {
    throw new Error(`This repayment has already been reversed in transaction ${existingReversal._id}.`);
  }

  const facility = await BusinessCreditFacility.findById(origTxn.facilityId);
  if (!facility) throw new Error("Facility not found.");

  const principalBefore = facility.principalOutstanding;
  const interestOutstandingBefore = facility.interestOutstanding;
  const totalPayableBefore = facility.totalPayable;

  // Restore facility balances
  const effectiveReversed = Number((origTxn.principalComponent + origTxn.interestComponent + (origTxn.feeComponent || 0)).toFixed(2));
  facility.principalPaidTotal = Math.max(0, Number(((facility.principalPaidTotal || 0) - origTxn.principalComponent).toFixed(2)));
  facility.interestPaidTotal = Math.max(0, Number(((facility.interestPaidTotal || 0) - origTxn.interestComponent).toFixed(2)));
  facility.totalPaid = Math.max(0, Number(((facility.totalPaid || 0) - effectiveReversed).toFixed(2)));

  facility.principalOutstanding = Number((facility.principalOutstanding + origTxn.principalComponent).toFixed(2));
  facility.interestOutstanding = Number((facility.interestOutstanding + origTxn.interestComponent).toFixed(2));
  facility.totalPayable = Number((facility.principalOutstanding + facility.interestOutstanding).toFixed(2));

  if (facility.status === "SETTLED" && (facility.principalOutstanding > 0 || facility.interestOutstanding > 0)) {
    facility.status = "ACTIVE";
    facility.settledAt = null;
  }

  // Reopen schedules in reverse order of payment
  let principalToReopen = origTxn.principalComponent;
  let interestToReopen = origTxn.interestComponent;

  const paidSchedules = await BusinessCreditSchedule.find({
    facilityId: facility._id,
    $or: [{ principalPaid: { $gt: 0 } }, { interestPaid: { $gt: 0 } }]
  }).sort({ instalmentNumber: -1 });

  for (const inst of paidSchedules) {
    if (principalToReopen <= 0 && interestToReopen <= 0) break;

    const pRev = Math.min(principalToReopen, inst.principalPaid);
    const iRev = Math.min(interestToReopen, inst.interestPaid);

    inst.principalPaid = Number((inst.principalPaid - pRev).toFixed(2));
    inst.interestPaid = Number((inst.interestPaid - iRev).toFixed(2));
    inst.totalPaid = Number((inst.totalPaid - (pRev + iRev)).toFixed(2));

    if (inst.totalPaid <= 0) {
      inst.status = new Date() > inst.dueDate ? "OVERDUE" : "DUE";
      inst.paidAt = null;
    } else {
      inst.status = "PARTIALLY_PAID";
    }

    principalToReopen = Number((principalToReopen - pRev).toFixed(2));
    interestToReopen = Number((interestToReopen - iRev).toFixed(2));
    await inst.save();
  }

  // Update next due instalment
  const nextInst = await BusinessCreditSchedule.findOne({
    facilityId: facility._id,
    status: { $in: ["OVERDUE", "DUE", "UPCOMING", "PARTIALLY_PAID"] }
  }).sort({ instalmentNumber: 1 });

  if (nextInst) {
    facility.nextDueDate = nextInst.dueDate;
    facility.nextDueAmount = Math.max(0, Number((nextInst.totalDue - nextInst.totalPaid).toFixed(2)));
  }

  await facility.save();

  // Create append-only REVERSAL transaction in ledger
  const reversalTxn = await BusinessCreditTransaction.create({
    facilityId: facility._id,
    retailerId: facility.retailerId,
    type: "REVERSAL",
    amount: origTxn.amount,
    principalComponent: origTxn.principalComponent,
    interestComponent: origTxn.interestComponent,
    feeComponent: origTxn.feeComponent,
    principalOutstandingBefore,
    principalOutstandingAfter: facility.principalOutstanding,
    interestOutstandingBefore,
    interestOutstandingAfter: facility.interestOutstanding,
    totalPayableBefore,
    totalPayableAfter: facility.totalPayable,
    method: "MANUAL_ADJUSTMENT",
    paymentDetails: {
      originalTransactionId: origTxn._id.toString(),
      originalMethod: origTxn.method,
      reversalReason: reason.trim()
    },
    idempotencyKey: `REVERSAL-${origTxn._id}`,
    reason: `Reversal of Repayment ${origTxn._id}. Reason: ${reason.trim()}`,
    createdBy: String(adminId || "ADMIN"),
    createdByName: adminName || "Admin"
  });

  await AuditLog.create({
    actorId: String(adminId),
    actorRole: "admin",
    type: "BUSINESS_CREDIT_REVERSAL",
    entityType: "BUSINESS_CREDIT_FACILITY",
    entityId: facility._id.toString(),
    note: `Repayment of ₹${origTxn.amount} reversed for facility ${facility.facilityNumber}. Reason: ${reason.trim()}`
  });

  return { facility, reversalTransaction: reversalTxn };
}

/**
 * Daily interest accrual job
 * Idempotently and concurrency-safely executes once per facility per business date
 * Supports missed scheduler run catch-up and zero-interest safe handling
 */
export async function accrueDailyInterestForActiveFacilities() {
  const todayStr = getBusinessDateString();
  const activeFacilities = await BusinessCreditFacility.find({
    status: "ACTIVE",
    principalOutstanding: { $gt: 0 }
  });

  let processedCount = 0;
  let totalAccrued = 0;
  const errors = [];

  for (const fac of activeFacilities) {
    try {
      // 1. Concurrency guard: Unique idempotency key per facility per business date
      const idempotencyKey = `ACCRUAL-${fac._id}-${todayStr}`;

      const existingAccrual = await BusinessCreditTransaction.findOne({ idempotencyKey });
      if (existingAccrual) {
        continue;
      }

      // Check lastInterestAccrualDate
      const lastAccrualStr = fac.lastInterestAccrualDate
        ? getBusinessDateString(fac.lastInterestAccrualDate)
        : null;

      if (lastAccrualStr === todayStr) {
        continue;
      }

      // 2. Days elapsed (handles missed scheduler runs accurately)
      const now = new Date();
      const lastDate = fac.lastInterestAccrualDate ? new Date(fac.lastInterestAccrualDate) : now;
      const diffMs = now.getTime() - lastDate.getTime();
      const days = Math.max(1, Math.floor(diffMs / (24 * 60 * 60 * 1000)));

      // 3. Compute interest using the approved method on the facility
      const result = calculateAccruedInterest({
        principal: fac.principalOutstanding,
        annualRatePercent: fac.interestRatePerAnnum,
        days,
        dayCountConvention: fac.dayCountConvention || "ACTUAL_365",
        interestMethod: fac.interestMethod || "DAILY_COMPOUNDING"
      });

      // 4. Handle zero-interest days safely
      if (!result.interest || result.interest <= 0) {
        continue;
      }

      const interestBefore = fac.interestOutstanding;
      const payableBefore = fac.totalPayable;
      const newInterestOutstanding = Number(((fac.interestOutstanding || 0) + result.interest).toFixed(2));
      const newInterestAccruedTotal = Number(((fac.interestAccruedTotal || 0) + result.interest).toFixed(2));
      const newTotalPayable = Number((fac.principalOutstanding + newInterestOutstanding).toFixed(2));

      // 5. Concurrency-Safe Posting:
      // Prefer multi-document transaction on replica sets. Fallback to Ledger-First on standalone.
      // In both modes, duplicate key on idempotencyKey rejects BEFORE facility state can be corrupted,
      // eliminating unsafe compensating rollbacks.
      const session = await mongoose.startSession().catch(() => null);
      let sessionUsed = false;

      if (session && typeof session.withTransaction === "function") {
        try {
          await session.withTransaction(async () => {
            await BusinessCreditTransaction.create(
              [
                {
                  facilityId: fac._id,
                  retailerId: fac.retailerId,
                  type: "INTEREST_ACCRUAL",
                  amount: result.interest,
                  principalComponent: 0,
                  interestComponent: result.interest,
                  feeComponent: 0,
                  principalOutstandingBefore: fac.principalOutstanding,
                  principalOutstandingAfter: fac.principalOutstanding,
                  interestOutstandingBefore: interestBefore,
                  interestOutstandingAfter: newInterestOutstanding,
                  totalPayableBefore: payableBefore,
                  totalPayableAfter: newTotalPayable,
                  method: "SYSTEM",
                  idempotencyKey,
                  reason: `Daily ${fac.interestMethod || "DAILY_COMPOUNDING"} interest accrual for ${todayStr} (${days} day/s @ ${fac.interestRatePerAnnum}% p.a.)`,
                  createdBy: "SYSTEM",
                  createdByName: "Interest Accrual Engine"
                }
              ],
              { session }
            );

            await BusinessCreditFacility.updateOne(
              { _id: fac._id },
              {
                $inc: {
                  interestAccruedTotal: result.interest,
                  interestOutstanding: result.interest,
                  totalPayable: result.interest
                },
                $set: {
                  lastInterestAccrualDate: now
                }
              },
              { session }
            );
          });
          sessionUsed = true;
        } catch (txErr) {
          if (txErr.code === 11000 || txErr.message?.includes("E11000")) {
            // Duplicate key safely aborted the transaction; no partial mutations committed
            continue;
          }
          // If transactions not supported on this cluster type, fall through to ledger-first
          if (!txErr.message?.includes("Transaction numbers are only allowed")) {
            throw txErr;
          }
        } finally {
          await session.endSession().catch(() => {});
        }
      }

      if (!sessionUsed) {
        // Provably safe Ledger-First Posting (Zero compensating rollback):
        // 1. Insert transaction with unique idempotencyKey FIRST
        try {
          await BusinessCreditTransaction.create({
            facilityId: fac._id,
            retailerId: fac.retailerId,
            type: "INTEREST_ACCRUAL",
            amount: result.interest,
            principalComponent: 0,
            interestComponent: result.interest,
            feeComponent: 0,
            principalOutstandingBefore: fac.principalOutstanding,
            principalOutstandingAfter: fac.principalOutstanding,
            interestOutstandingBefore: interestBefore,
            interestOutstandingAfter: newInterestOutstanding,
            totalPayableBefore: payableBefore,
            totalPayableAfter: newTotalPayable,
            method: "SYSTEM",
            idempotencyKey,
            reason: `Daily ${fac.interestMethod || "DAILY_COMPOUNDING"} interest accrual for ${todayStr} (${days} day/s @ ${fac.interestRatePerAnnum}% p.a.)`,
            createdBy: "SYSTEM",
            createdByName: "Interest Accrual Engine"
          });
        } catch (txErr) {
          if (txErr.code === 11000 || txErr.message?.includes("E11000")) {
            // Duplicate accrual safely rejected by unique index BEFORE facility was touched
            continue;
          }
          throw txErr;
        }

        // 2. Transaction succeeded; atomically update facility
        await BusinessCreditFacility.updateOne(
          { _id: fac._id },
          {
            $inc: {
              interestAccruedTotal: result.interest,
              interestOutstanding: result.interest,
              totalPayable: result.interest
            },
            $set: {
              lastInterestAccrualDate: now
            }
          }
        );
      }

      // Update in-memory facility object
      fac.interestAccruedTotal = newInterestAccruedTotal;
      fac.interestOutstanding = newInterestOutstanding;
      fac.totalPayable = newTotalPayable;
      fac.lastInterestAccrualDate = now;

      processedCount++;
      totalAccrued = Number((totalAccrued + result.interest).toFixed(2));
    } catch (facErr) {
      console.error(`[InterestAccrual] Error processing facility ${fac._id}:`, facErr);
      errors.push({ facilityId: fac._id, error: facErr.message });
    }
  }

  return { processedCount, totalAccrued, errors };
}

/**
 * Pure invariant evaluation function across facility, schedules, and ledger transactions
 */
export function evaluateFacilityInvariants({ facility, schedules = [], transactions = [] }) {
  const discrepancies = [];

  // Invariant 1: Principal balance arithmetic
  const expectedPrincipalOutstanding = Number(((facility.disbursedAmount || 0) - (facility.principalPaidTotal || 0)).toFixed(2));
  if (Math.abs(expectedPrincipalOutstanding - facility.principalOutstanding) > 0.05) {
    discrepancies.push({
      type: "PRINCIPAL_ARITHMETIC_MISMATCH",
      expected: expectedPrincipalOutstanding,
      actual: facility.principalOutstanding
    });
  }

  // Invariant 2: Interest balance arithmetic
  const expectedInterestOutstanding = Number(((facility.interestAccruedTotal || 0) - (facility.interestPaidTotal || 0)).toFixed(2));
  if (Math.abs(expectedInterestOutstanding - facility.interestOutstanding) > 0.05) {
    discrepancies.push({
      type: "INTEREST_ARITHMETIC_MISMATCH",
      expected: expectedInterestOutstanding,
      actual: facility.interestOutstanding
    });
  }

  // Invariant 3: Total Payable equation
  const expectedTotalPayable = Number((facility.principalOutstanding + facility.interestOutstanding).toFixed(2));
  if (Math.abs(expectedTotalPayable - facility.totalPayable) > 0.05) {
    discrepancies.push({
      type: "TOTAL_PAYABLE_MISMATCH",
      expected: expectedTotalPayable,
      actual: facility.totalPayable
    });
  }

  // Invariant 4: Sum of unpaid schedule principal vs facility principal outstanding
  const schedulePrincipalUnpaid = schedules.reduce((sum, s) => {
    return sum + Math.max(0, s.principalDue - (s.principalPaid || 0));
  }, 0);
  const roundedSchedulePrincipal = Number(schedulePrincipalUnpaid.toFixed(2));

  if (schedules.length > 0 && Math.abs(roundedSchedulePrincipal - facility.principalOutstanding) > 0.10) {
    discrepancies.push({
      type: "SCHEDULE_PRINCIPAL_MISMATCH",
      scheduleTotal: roundedSchedulePrincipal,
      facilityOutstanding: facility.principalOutstanding
    });
  }

  // Invariant 5: Ledger repayments vs facility totalPaid
  const ledgerTotalRepaid = transactions
    .filter(t => t.type === "REPAYMENT")
    .reduce((sum, t) => sum + (t.principalComponent + t.interestComponent + (t.feeComponent || 0)), 0);
  const ledgerReversals = transactions
    .filter(t => t.type === "REVERSAL")
    .reduce((sum, t) => sum + (t.principalComponent + t.interestComponent + (t.feeComponent || 0)), 0);
  const netLedgerRepaid = Number((ledgerTotalRepaid - ledgerReversals).toFixed(2));

  if (transactions.length > 0 && Math.abs(netLedgerRepaid - facility.totalPaid) > 0.10) {
    discrepancies.push({
      type: "LEDGER_PAYMENT_MISMATCH",
      ledgerNetPaid: netLedgerRepaid,
      facilityTotalPaid: facility.totalPaid
    });
  }

  return {
    facilityId: facility._id,
    facilityNumber: facility.facilityNumber,
    status: facility.status,
    invariantsPassed: discrepancies.length === 0,
    discrepancies,
    metrics: {
      principalOutstanding: facility.principalOutstanding,
      interestOutstanding: facility.interestOutstanding,
      totalPayable: facility.totalPayable,
      schedulePrincipalUnpaid: roundedSchedulePrincipal,
      netLedgerRepaid
    }
  };
}

/**
 * Checks financial invariants across facility balances, schedules, and transactions
 */
export async function verifyFacilityInvariants(facilityId) {
  const facility = await BusinessCreditFacility.findById(facilityId);
  if (!facility) throw new Error("Facility not found.");

  const [schedules, transactions] = await Promise.all([
    BusinessCreditSchedule.find({ facilityId: facility._id }),
    BusinessCreditTransaction.find({ facilityId: facility._id })
  ]);

  return evaluateFacilityInvariants({ facility, schedules, transactions });
}

/**
 * Reconciles invariants and applies an audited adjustment if requested
 */
export async function reconcileFacilityInvariants({ facilityId, autoFix = false, adminId, adminName, reason }) {
  const check = await verifyFacilityInvariants(facilityId);
  if (check.invariantsPassed || !autoFix) {
    return check;
  }

  const facility = await BusinessCreditFacility.findById(facilityId);

  const truePrincipal = check.metrics.schedulePrincipalUnpaid;
  const trueTotalPayable = Number((truePrincipal + facility.interestOutstanding).toFixed(2));
  const principalDelta = Number((truePrincipal - facility.principalOutstanding).toFixed(2));

  facility.principalOutstanding = truePrincipal;
  facility.totalPayable = trueTotalPayable;
  await facility.save();

  await BusinessCreditTransaction.create({
    facilityId: facility._id,
    retailerId: facility.retailerId,
    type: "ADJUSTMENT",
    amount: Math.abs(principalDelta),
    principalComponent: principalDelta,
    interestComponent: 0,
    feeComponent: 0,
    principalOutstandingBefore: facility.principalOutstanding - principalDelta,
    principalOutstandingAfter: facility.principalOutstanding,
    interestOutstandingBefore: facility.interestOutstanding,
    interestOutstandingAfter: facility.interestOutstanding,
    totalPayableBefore: check.metrics.totalPayable,
    totalPayableAfter: facility.totalPayable,
    method: "MANUAL_ADJUSTMENT",
    idempotencyKey: `RECON-ADJ-${facility._id}-${Date.now()}`,
    reason: `Audited invariant reconciliation adjustment by ${adminName || 'Admin'}. Reason: ${reason || 'Schedule balance alignment'}`,
    createdBy: String(adminId || "ADMIN"),
    createdByName: adminName || "Admin"
  });

  await AuditLog.create({
    actorId: String(adminId),
    actorRole: "admin",
    type: "BUSINESS_CREDIT_RECONCILIATION_ADJUSTMENT",
    entityType: "BUSINESS_CREDIT_FACILITY",
    entityId: facility._id.toString(),
    note: `Reconciled facility ${facility.facilityNumber}. Discrepancies fixed with audited ADJUSTMENT.`
  });

  return await verifyFacilityInvariants(facilityId);
}

/**
 * Ensures unique and sparse indexes are registered in MongoDB
 */
export async function ensureBusinessCreditIndexes() {
  const models = [
    BusinessCreditTransaction,
    BusinessCreditFacility,
    BusinessCreditSchedule,
    BusinessCreditApplication
  ];

  for (const m of models) {
    if (m && typeof m.createIndexes === "function") {
      await m.createIndexes().catch((err) => {
        console.warn(`[DB] Failed to create index on ${m.modelName}:`, err.message);
      });
    }
  }
}

