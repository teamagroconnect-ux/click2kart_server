import mongoose from "mongoose";

const creditLedgerSchema = new mongoose.Schema(
  {
    retailerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true
    },
    amount: {
      type: Number,
      required: true
    },
    type: {
      type: String,
      enum: [
        "CREDIT_GRANTED",
        "CREDIT_ADDED",
        "CREDIT_USED",
        "CREDIT_REPAID",
        "CREDIT_ADJUSTMENT",
        "REFUND_CREDIT",
        "REVERSAL"
      ],
      required: true,
      index: true
    },
    referenceId: {
      type: String,
      default: "",
      index: true
    },
    referenceType: {
      type: String,
      enum: ["ORDER", "REPAYMENT", "ADMIN_ADJUSTMENT", "REFUND", "INITIAL_SETUP", "OTHER"],
      default: "OTHER"
    },
    balanceBefore: {
      type: Number,
      required: true
    },
    balanceAfter: {
      type: Number,
      required: true
    },
    outstandingBefore: {
      type: Number,
      default: 0
    },
    outstandingAfter: {
      type: Number,
      default: 0
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
      default: ""
    }
  },
  {
    timestamps: { createdAt: true, updatedAt: false }
  }
);

creditLedgerSchema.index({ retailerId: 1, createdAt: -1 });

export default mongoose.models.CreditLedger || mongoose.model("CreditLedger", creditLedgerSchema);
