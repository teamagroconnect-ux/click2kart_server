import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    gst: { type: Number, required: true },
    quantity: { type: Number, required: true },
    lineTotal: { type: Number, required: true },
    image: { type: String, default: "" }
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    type: { type: String, default: "ENQUIRY" },
    billId: { type: mongoose.Schema.Types.ObjectId, ref: "Bill" },
    customer: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      email: { type: String, default: "" }
    },
    items: { type: [orderItemSchema], required: true },
    totalEstimate: { type: Number, required: true },
    paymentMethod: { type: String, enum: ["CASH", "RAZORPAY"], default: "CASH" },
    paymentStatus: { type: String, enum: ["PENDING", "PARTIAL", "PAID", "FAILED", "REFUNDED"], default: "PENDING" },
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },
    codAdvancePercent: { type: Number, default: 0 },
    advancePaidAmount: { type: Number, default: 0 },
    codDueAmount: { type: Number, default: 0 },
    status: { 
      type: String, 
      enum: ["NEW", "PENDING_CASH_APPROVAL", "CONFIRMED", "CANCELLED", "FULFILLED"], 
      default: "NEW" 
    },
    notes: { type: String, default: "" },
    feedbackRating: { type: Number, min: 1, max: 5 },
    shipping: {
      provider: { type: String },
      waybill: { type: String },
      status: { type: String },
      trackingUrl: { type: String }
    },
    shippingAddress: {
      line1: { type: String },
      line2: { type: String },
      city: { type: String },
      state: { type: String },
      pincode: { type: String }
    }
  },
  { timestamps: true }
);

export default mongoose.models.Order || mongoose.model("Order", orderSchema);
