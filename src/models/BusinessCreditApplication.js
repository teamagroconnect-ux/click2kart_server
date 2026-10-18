import mongoose from "mongoose";

const businessCreditApplicationSchema = new mongoose.Schema(
  {
    applicationNumber: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    retailerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true
    },
    requestedAmount: {
      type: Number,
      required: true,
      min: 1000
    },
    purpose: {
      type: String,
      required: true,
      trim: true
    },
    requestedTenureMonths: {
      type: Number,
      required: true,
      min: 1,
      max: 12
    },
    businessDetails: {
      shopName: { type: String, trim: true },
      tradeName: { type: String, trim: true },
      pan: { type: String, trim: true },
      gstin: { type: String, trim: true },
      monthlyTurnover: { type: Number, default: 0 },
      bankDetails: {
        accountHolder: { type: String, default: "" },
        accountNumber: { type: String, default: "" },
        ifsc: { type: String, default: "" },
        bankName: { type: String, default: "" },
        branch: { type: String, default: "" },
        accountType: { type: String, default: "CURRENT" }
      }
    },
    supportingDocuments: [
      {
        docType: { type: String, enum: ["BANK_STATEMENT", "GST_RETURN", "ITR", "SHOP_PHOTO", "TRADE_LICENSE", "OTHER"] },
        title: { type: String, default: "" },
        url: { type: String, required: true },
        uploadedAt: { type: Date, default: Date.now }
      }
    ],
    status: {
      type: String,
      enum: [
        "DRAFT",
        "SUBMITTED",
        "UNDER_REVIEW",
        "ADDITIONAL_INFO_REQUIRED",
        "APPROVED",
        "OFFER_ACCEPTED",
        "REJECTED",
        "CANCELLED",
        "DISBURSEMENT_PENDING",
        "DISBURSED",
        "CLOSED"
      ],
      default: "SUBMITTED",
      index: true
    },
    isProactiveGrant: {
      type: Boolean,
      default: false
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin"
    },
    reviewedByName: {
      type: String,
      default: ""
    },
    reviewedAt: {
      type: Date
    },
    adminNotes: {
      type: String,
      default: ""
    },
    rejectionReason: {
      type: String,
      default: ""
    },
    // Approved financial terms snapshot (locked once approved)
    approvedOffer: {
      approvedAmount: { type: Number, default: 0 },
      approvedTenureMonths: { type: Number, min: 1, max: 12 },
      interestRatePerAnnum: { type: Number, default: 18.0 },
      interestMethod: { type: String, default: "DAILY_COMPOUNDING" },
      repaymentFrequency: { type: String, enum: ["WEEKLY", "DAILY"], default: "WEEKLY" },
      processingFeeAmount: { type: Number, default: 0 },
      processingFeeGst: { type: Number, default: 0 },
      totalProcessingFee: { type: Number, default: 0 },
      netDisbursementAmount: { type: Number, default: 0 },
      estimatedTotalInterest: { type: Number, default: 0 },
      estimatedTotalPayable: { type: Number, default: 0 },
      instalmentEstimate: { type: Number, default: 0 },
      totalInstalments: { type: Number, default: 0 },
      offerExpiresAt: { type: Date },
      offerAcceptedAt: { type: Date },
      offerAcceptedIp: { type: String, default: "" },
      agreementText: { type: String, default: "" },
      agreementAccepted: { type: Boolean, default: false }
    },
    facilityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessCreditFacility"
    },
    timeline: [
      {
        status: { type: String, required: true },
        title: { type: String, required: true },
        description: { type: String, default: "" },
        timestamp: { type: Date, default: Date.now },
        performedBy: { type: String, default: "SYSTEM" }
      }
    ]
  },
  { timestamps: true }
);

businessCreditApplicationSchema.index({ retailerId: 1, status: 1 });
businessCreditApplicationSchema.index({ createdAt: -1 });

export default mongoose.models.BusinessCreditApplication ||
  mongoose.model("BusinessCreditApplication", businessCreditApplicationSchema);
