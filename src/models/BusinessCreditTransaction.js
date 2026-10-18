import mongoose from "mongoose";

const businessCreditTransactionSchema = new mongoose.Schema(
  {
    facilityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessCreditFacility",
      required: true,
      index: true
    },
    retailerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true
    },
    type: {
      type: String,
      enum: [
        "DISBURSEMENT",
        "PROCESSING_FEE",
        "INTEREST_ACCRUAL",
        "REPAYMENT",
        "ADJUSTMENT",
        "REVERSAL",
        "PENALTY",
        "AUTOPAY",
        "MANDATE_REGISTRATION"
      ],
      required: true,
      index: true
    },
    amount: {
      type: Number,
      required: true
    },
    principalComponent: {
      type: Number,
      default: 0
    },
    interestComponent: {
      type: Number,
      default: 0
    },
    feeComponent: {
      type: Number,
      default: 0
    },
    // Accounting snapshots
    principalOutstandingBefore: {
      type: Number,
      default: 0
    },
    principalOutstandingAfter: {
      type: Number,
      default: 0
    },
    interestOutstandingBefore: {
      type: Number,
      default: 0
    },
    interestOutstandingAfter: {
      type: Number,
      default: 0
    },
    totalPayableBefore: {
      type: Number,
      default: 0
    },
    totalPayableAfter: {
      type: Number,
      default: 0
    },
    method: {
      type: String,
      enum: [
        "SYSTEM",
        "RAZORPAY",
        "BANK_TRANSFER",
        "NEFT",
        "RTGS",
        "IMPS",
        "CHEQUE",
        "CASH",
        "UPI",
        "AUTOPAY",
        "MANUAL_ADJUSTMENT"
      ],
      default: "SYSTEM"
    },
    paymentDetails: {
      razorpayOrderId: { type: String, default: "" },
      razorpayPaymentId: { type: String, default: "" },
      utr: { type: String, default: "" },
      mandateId: { type: String, default: "" },
      paymentSlip: { type: String, default: "" },
      bankName: { type: String, default: "" },
      notes: { type: String, default: "" }
    },
    instalmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessCreditSchedule"
    },
    idempotencyKey: {
      type: String,
      unique: true,
      sparse: true,
      index: true
    },
    reason: {
      type: String,
      required: true,
      trim: true
    },
    createdBy: {
      type: String,
      default: "SYSTEM"
    },
    createdByName: {
      type: String,
      default: "System"
    }
  },
  {
    timestamps: { createdAt: true, updatedAt: false }
  }
);

businessCreditTransactionSchema.index({ facilityId: 1, createdAt: -1 });
businessCreditTransactionSchema.index({ retailerId: 1, createdAt: -1 });

export default mongoose.models.BusinessCreditTransaction ||
  mongoose.model("BusinessCreditTransaction", businessCreditTransactionSchema);
