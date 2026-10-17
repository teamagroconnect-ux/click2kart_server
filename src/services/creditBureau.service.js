import BusinessCreditFacility from "../models/BusinessCreditFacility.js";
import BusinessCreditSchedule from "../models/BusinessCreditSchedule.js";
import Customer from "../models/Customer.js";

/**
 * Service to generate structured credit bureau reporting extracts
 * Compatible with RBI / CIBIL / Experian / Equifax commercial bureau data formats
 */

/**
 * Generate Bureau Reporting Dataset for all or active Business Credit Facilities
 */
export const generateBureauReport = async ({ statusFilter = null, asOfDate = new Date() } = {}) => {
  const query = {};
  if (statusFilter) {
    query.status = statusFilter;
  } else {
    query.status = { $in: ["ACTIVE", "OVERDUE", "DEFAULTED", "CLOSED"] };
  }

  const facilities = await BusinessCreditFacility.find(query)
    .populate("retailerId", "name businessName email phone gstin pan address city state pincode kycStatus")
    .sort({ createdAt: -1 });

  const bureauRecords = [];

  for (const fac of facilities) {
    const retailer = fac.retailerId || {};

    // Get all schedules to compute DPD and repayment track record
    const schedules = await BusinessCreditSchedule.find({ facilityId: fac._id }).sort({ instalmentNumber: 1 });

    let dpd = 0; // Days Past Due
    let oldestOverdueDate = null;
    let missedCount = 0;
    let paidCount = 0;

    const paymentTrack = schedules.map(sch => {
      const isPastDue = sch.status !== "PAID" && new Date(sch.dueDate) < asOfDate;
      if (isPastDue) {
        missedCount++;
        if (!oldestOverdueDate || new Date(sch.dueDate) < oldestOverdueDate) {
          oldestOverdueDate = new Date(sch.dueDate);
        }
      }
      if (sch.status === "PAID") {
        paidCount++;
      }

      return {
        instalmentNumber: sch.instalmentNumber,
        dueDate: sch.dueDate,
        totalDue: (sch.principalDue || 0) + (sch.interestDue || 0) + (sch.feeDue || 0),
        status: sch.status,
        paidAt: sch.paidAt || null,
        dpdAtDueDate: isPastDue ? Math.max(0, Math.floor((asOfDate - new Date(sch.dueDate)) / (1000 * 60 * 60 * 24))) : 0
      };
    });

    if (oldestOverdueDate) {
      dpd = Math.max(0, Math.floor((asOfDate - oldestOverdueDate) / (1000 * 60 * 60 * 24)));
    }

    // Asset classification as per RBI norms
    let assetClassification = "STD"; // Standard
    if (dpd > 90) {
      assetClassification = "SUB"; // Sub-standard (NPA)
    } else if (dpd > 60) {
      assetClassification = "SMA-2"; // Special Mention Account 2
    } else if (dpd > 30) {
      assetClassification = "SMA-1"; // Special Mention Account 1
    } else if (dpd > 0) {
      assetClassification = "SMA-0"; // Special Mention Account 0
    }

    bureauRecords.push({
      // 1. Borrower Identification Segment
      borrower: {
        retailerId: retailer._id,
        entityName: retailer.businessName || retailer.name || "N/A",
        keyPersonName: retailer.name || "N/A",
        pan: fac.agreementSnapshot?.pan || retailer.pan || "N/A",
        gstin: fac.agreementSnapshot?.gstin || retailer.gstin || "N/A",
        phone: fac.agreementSnapshot?.phone || retailer.phone || "N/A",
        email: retailer.email || "N/A",
        registeredAddress: {
          address: retailer.address || "N/A",
          city: retailer.city || "N/A",
          state: retailer.state || "N/A",
          pincode: retailer.pincode || "N/A"
        },
        kycStatus: retailer.kycStatus || "VERIFIED"
      },

      // 2. Account / Facility Segment
      account: {
        facilityId: fac._id,
        facilityNumber: fac.facilityNumber,
        creditType: "BUSINESS_CREDIT_LINE", // Commercial Short-Term Business Loan
        sanctionDate: fac.sanctionedAt || fac.createdAt,
        disbursedDate: fac.disbursedAt || fac.sanctionedAt,
        sanctionedAmount: fac.sanctionedLimit,
        disbursedAmount: fac.disbursedAmount,
        interestRateAnnual: fac.annualInterestRatePercent,
        compoundingMethod: fac.interestCompoundingFrequency || "DAILY",
        tenureMonths: fac.tenureMonths,
        repaymentFrequency: fac.repaymentFrequency,
        accountStatus: fac.status,
        closureDate: fac.status === "CLOSED" ? fac.updatedAt : null
      },

      // 3. Balance and Performance Segment
      performance: {
        asOfDate,
        currentOutstandingTotal: fac.totalPayable,
        principalOutstanding: fac.currentPrincipalBalance,
        interestAccruedOutstanding: fac.accruedInterestUnpaid,
        overdueAmount: fac.overdueAmount,
        daysPastDue: dpd,
        assetClassification,
        totalInstalments: schedules.length,
        paidInstalments: paidCount,
        overdueInstalments: missedCount,
        nextDueDate: fac.nextDueDate || null,
        mandateStatus: fac.autoPayMandate?.status || "NOT_SET"
      },

      // 4. Payment History Grid (Monthly / Periodic Snapshot)
      paymentTrack
    });
  }

  return {
    reportGeneratedAt: asOfDate,
    bureauFormatVersion: "CIBIL_COMMERCIAL_V3_READY",
    totalFacilities: bureauRecords.length,
    summary: {
      standardAccounts: bureauRecords.filter(r => r.performance.assetClassification === "STD").length,
      smaAccounts: bureauRecords.filter(r => r.performance.assetClassification.startsWith("SMA")).length,
      npaAccounts: bureauRecords.filter(r => r.performance.assetClassification === "SUB").length,
      totalOutstanding: bureauRecords.reduce((acc, r) => acc + (r.performance.currentOutstandingTotal || 0), 0)
    },
    records: bureauRecords
  };
};
