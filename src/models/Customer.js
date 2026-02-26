import mongoose from "mongoose";
import bcrypt from "bcrypt";

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true, unique: true },
    email: { type: String, unique: true, lowercase: true, trim: true, sparse: true },
    password: { type: String, minlength: 6 },
    address: { type: String, default: "" },
    purchaseHistory: [{ type: mongoose.Schema.Types.ObjectId, ref: "Bill" }],
    isVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

customerSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

customerSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

customerSchema.index({ phone: 1 }, { unique: true });

export default mongoose.models.Customer || mongoose.model("Customer", customerSchema);

