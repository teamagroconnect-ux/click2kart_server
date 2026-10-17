import mongoose from "mongoose";

const creditProductSettingsSchema = new mongoose.Schema(
  {
    productKey: {
      type: String,
      required: true,
      unique: true,
      default: "BUSINESS_CREDIT_LINE"
    },
    productName: {
      type: String,
      default: "Click2Kart Business Credit Line"
    },
    isEnabled: {
      type: Boolean,
      default: true
    },
    isApplicationAcceptanceEnabled: {
      type: Boolean,
      default: true
    },
    // Eligibility criteria
    eligibility: {
      minTradeOrders: { type: Number, default: 0 },
      minTradeRepayments: { type: Number, default: 0 },
      requireKycVerified: { type: Boolean, default: true },
      requireActiveTradeLine: { type: Boolean, default: true },
      maxActiveApplications: { type: Number, default: 1 }
    },
    // Financial limits
    minAmount: {
      type: Number,
      default: 10000,
      min: 1000
    },
    maxAmount: {
      type: Number,
      default: 500000,
      min: 1000
    },
    // Tenure in months (Strictly 3 to 5 months)
    defaultTenureMonths: {
      type: Number,
      default: 3,
      min: 3,
      max: 5
    },
    maxTenureMonths: {
      type: Number,
      default: 5,
      min: 3,
      max: 5
    },
    permittedTenures: {
      type: [Number],
      default: [3, 4, 5]
    },
    // Repayment frequency
    repaymentFrequency: {
      type: String,
      enum: ["WEEKLY", "DAILY"],
      default: "WEEKLY"
    },
    // Pricing: Daily Compounding Interest
    interestRatePerAnnum: {
      type: Number,
      default: 18.0, // 18% p.a.
      min: 0,
      max: 60
    },
    interestMethod: {
      type: String,
      enum: ["DAILY_COMPOUNDING", "REDUCING_BALANCE"],
      default: "DAILY_COMPOUNDING"
    },
    dayCountConvention: {
      type: String,
      enum: ["ACTUAL_365", "ACTUAL_360"],
      default: "ACTUAL_365"
    },
    // Processing fee
    processingFeeType: {
      type: String,
      enum: ["PERCENTAGE", "FIXED"],
      default: "PERCENTAGE"
    },
    processingFeeValue: {
      type: Number,
      default: 2.0, // 2%
      min: 0
    },
    processingFeeGstPercent: {
      type: Number,
      default: 18.0 // 18% GST on processing fee
    },
    deductFeeFromDisbursement: {
      type: Boolean,
      default: true
    },
    // Servicing & Grace period
    gracePeriodDays: {
      type: Number,
      default: 3,
      min: 0
    },
    autoPayEnabled: {
      type: Boolean,
      default: false
    },
    latePenaltyRatePerAnnum: {
      type: Number,
      default: 24.0 // 24% p.a. on overdue principal
    },
    updatedBy: {
      type: String,
      default: "SYSTEM"
    }
  },
  { timestamps: true }
);

export default mongoose.models.CreditProductSettings ||
  mongoose.model("CreditProductSettings", creditProductSettingsSchema);
