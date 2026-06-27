import mongoose from "mongoose";
import bcrypt from "bcrypt";

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true, unique: true },
    whatsappNumber: { type: String, default: '', trim: true },
    email: { type: String, unique: true, lowercase: true, trim: true, sparse: true },
    password: { type: String, minlength: 6 },
    address: { type: String, default: "" },
    addresses: [{ 
      fullName: String, 
      phone: String, 
      addressLine1: String, 
      addressLine2: String, 
      city: String, 
      district: String, 
      state: String, 
      pincode: String, 
      isDefault: { type: Boolean, default: false } 
    }],
    purchaseHistory: [{ type: mongoose.Schema.Types.ObjectId, ref: "Bill" }],
    isVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    approvalStatus: { type: String, enum: ['pending', 'approved', 'skipped'], default: 'pending' },
    dob: { type: Date },
    kyc: {
      businessName: { type: String, default: "" },
      gstin: { type: String, default: "" },
      pan: { type: String, default: "" },
      panCard: { type: String, default: "" },
      aadhaarCard: { type: String, default: "" },
      addressLine1: { type: String, default: "" },
      addressLine2: { type: String, default: "" },
      city: { type: String, default: "" },
      district: { type: String, default: "" },
      state: { type: String, default: "" },
      pincode: { type: String, default: "" },
      profilePicture: { type: String, default: "" },
      partnerInviteCode: { type: String, default: "" }
    },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner", default: null },
    isKycComplete: { type: Boolean, default: false }
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

export default mongoose.models.Customer || mongoose.model("Customer", customerSchema);
