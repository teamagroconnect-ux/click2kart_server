import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    gst: { type: Number, required: true },
    quantity: { type: Number, required: true },
    lineTotal: { type: Number, required: true }
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    type: { type: String, default: "ENQUIRY" },
    customer: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      email: { type: String, default: "" }
    },
    items: { type: [orderItemSchema], required: true },
    totalEstimate: { type: Number, required: true },
    status: { type: String, enum: ["NEW", "CONFIRMED", "CANCELLED", "FULFILLED"], default: "NEW" },
    notes: { type: String, default: "" }
  },
  { timestamps: true }
);

export default mongoose.models.Order || mongoose.model("Order", orderSchema);

