import mongoose from "mongoose";

const creditRepaymentSchema = new mongoose.Schema(
  {
    retailerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true
    },
    amount: {
      type: Number,
      required: true,
      min: 1
    },
    method: {
      type: String,
      enum: ["RAZORPAY", "BANK_TRANSFER"],
      required: true
    },
    status: {
      type: String,
      enum: ["PAYMENT_PENDING", "PENDING_VERIFICATION", "SUCCESS", "REJECTED", "FAILED"],
      default: "PAYMENT_PENDING",
      index: true
    },
    razorpayOrderId: {
      type: String,
      default: "",
      index: true
    },
    razorpayPaymentId: {
      type: String,
      default: "",
      index: true
    },
    razorpaySignature: {
      type: String,
      default: ""
    },
    bankTransferDetails: {
      utr: { type: String, default: "" },
      paymentSlip: { type: String, default: "" },
      note: { type: String, default: "" },
      transferDate: { type: Date, default: Date.now }
    },
    verifiedBy: {
      type: String,
      default: ""
    },
    verifiedAt: {
      type: Date
    },
    rejectionReason: {
      type: String,
      default: ""
    },
    ledgerTxnId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CreditLedger"
    }
  },
  {
    timestamps: true
  }
);

creditRepaymentSchema.index({ retailerId: 1, createdAt: -1 });

export default mongoose.models.CreditRepayment || mongoose.model("CreditRepayment", creditRepaymentSchema);
