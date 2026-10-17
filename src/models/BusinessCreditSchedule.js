import mongoose from "mongoose";

const businessCreditScheduleSchema = new mongoose.Schema(
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
    instalmentNumber: {
      type: Number,
      required: true
    },
    dueDate: {
      type: Date,
      required: true,
      index: true
    },
    principalDue: {
      type: Number,
      required: true,
      default: 0
    },
    interestDue: {
      type: Number,
      required: true,
      default: 0
    },
    feeDue: {
      type: Number,
      default: 0
    },
    totalDue: {
      type: Number,
      required: true
    },
    principalPaid: {
      type: Number,
      default: 0
    },
    interestPaid: {
      type: Number,
      default: 0
    },
    feePaid: {
      type: Number,
      default: 0
    },
    totalPaid: {
      type: Number,
      default: 0
    },
    status: {
      type: String,
      enum: ["UPCOMING", "DUE", "PARTIALLY_PAID", "PAID", "OVERDUE"],
      default: "UPCOMING",
      index: true
    },
    paidAt: {
      type: Date
    },
    paymentReference: {
      type: String,
      default: ""
    },
    paymentTxnId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BusinessCreditTransaction"
    }
  },
  { timestamps: true }
);

businessCreditScheduleSchema.index({ facilityId: 1, instalmentNumber: 1 }, { unique: true });
businessCreditScheduleSchema.index({ retailerId: 1, dueDate: 1, status: 1 });

export default mongoose.models.BusinessCreditSchedule ||
  mongoose.model("BusinessCreditSchedule", businessCreditScheduleSchema);
