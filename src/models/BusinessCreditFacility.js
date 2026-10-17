import mongoose from "mongoose";

const businessCreditFacilitySchema = new mongoose.Schema(
  {
    facilityNumber: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessCreditApplication",
      required: true
    },
    retailerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true
    },
    status: {
      type: String,
      enum: ["ACTIVE", "SUSPENDED", "OVERDUE", "SETTLED", "CLOSED"],
      default: "ACTIVE",
      index: true
    },
    // Principal & Limits
    sanctionedLimit: {
      type: Number,
      required: true
    },
    disbursedAmount: {
      type: Number,
      required: true
    },
    disbursedAt: {
      type: Date,
      default: Date.now
    },
    tenureMonths: {
      type: Number,
      required: true,
      min: 3,
      max: 5
    },
    repaymentFrequency: {
      type: String,
      enum: ["WEEKLY", "DAILY"],
      default: "WEEKLY"
    },
    totalInstalments: {
      type: Number,
      required: true
    },
    // Pricing terms snapshot
    interestRatePerAnnum: {
      type: Number,
      required: true
    },
    interestMethod: {
      type: String,
      default: "DAILY_COMPOUNDING"
    },
    dayCountConvention: {
      type: String,
      default: "ACTUAL_365"
    },
    processingFeePaid: {
      type: Number,
      default: 0
    },
    // Balance Accounting (Strict distinctions)
    principalOutstanding: {
      type: Number,
      required: true
    },
    interestAccruedTotal: {
      type: Number,
      default: 0
    },
    interestOutstanding: {
      type: Number,
      default: 0
    },
    interestPaidTotal: {
      type: Number,
      default: 0
    },
    principalPaidTotal: {
      type: Number,
      default: 0
    },
    totalPaid: {
      type: Number,
      default: 0
    },
    overdueAmount: {
      type: Number,
      default: 0
    },
    totalPayable: {
      type: Number,
      required: true
    },
    // Daily compounding engine tracking
    lastInterestAccrualDate: {
      type: Date,
      default: Date.now
    },
    // Disbursement execution details
    disbursementDetails: {
      method: { type: String, default: "BANK_TRANSFER" },
      utr: { type: String, default: "" },
      accountHolder: { type: String, default: "" },
      accountNumber: { type: String, default: "" },
      ifsc: { type: String, default: "" },
      bankName: { type: String, default: "" },
      confirmedAt: { type: Date, default: Date.now },
      confirmedBy: { type: String, default: "" },
      notes: { type: String, default: "" }
    },
    // AutoPay / Mandate tracking
    autoPayMandate: {
      mandateId: { type: String, default: "" },
      provider: { type: String, default: "RAZORPAY" },
      status: {
        type: String,
        enum: ["NOT_REGISTERED", "PENDING", "ACTIVE", "FAILED", "REVOKED"],
        default: "NOT_REGISTERED"
      },
      registeredAt: { type: Date },
      lastDebitAttemptAt: { type: Date },
      lastDebitStatus: { type: String, default: "" },
      failureReason: { type: String, default: "" }
    },
    // Dates
    nextDueDate: {
      type: Date
    },
    nextDueAmount: {
      type: Number,
      default: 0
    },
    maturityDate: {
      type: Date
    },
    settledAt: {
      type: Date
    },
    // Credit Bureau reporting readiness
    bureauReport: {
      reported: { type: Boolean, default: false },
      lastReportedAt: { type: Date },
      accountStatus: { type: String, default: "STANDARD" }
    }
  },
  { timestamps: true }
);

businessCreditFacilitySchema.index({ retailerId: 1, status: 1 });
businessCreditFacilitySchema.index({ nextDueDate: 1 });

export default mongoose.models.BusinessCreditFacility ||
  mongoose.model("BusinessCreditFacility", businessCreditFacilitySchema);
