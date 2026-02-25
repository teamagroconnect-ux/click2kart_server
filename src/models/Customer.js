import mongoose from "mongoose";

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true, unique: true },
    email: { type: String, default: "" },
    address: { type: String, default: "" },
    purchaseHistory: [{ type: mongoose.Schema.Types.ObjectId, ref: "Bill" }],
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

customerSchema.index({ phone: 1 }, { unique: true });

export default mongoose.models.Customer || mongoose.model("Customer", customerSchema);

