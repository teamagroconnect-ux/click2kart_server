import mongoose from "mongoose";

const partnerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, default: "", trim: true, unique: true, lowercase: true },
    phone: { type: String, default: "", trim: true },
    password: { type: String, trim: true },
    otp: { type: String },
    otpExpiry: { type: Date },
    isActive: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    businessName: { type: String, trim: true },
    gstNumber: { type: String, trim: true, uppercase: true },
    panNumber: { type: String, trim: true, uppercase: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    bloodGroup: { type: String, trim: true, uppercase: true },
    profilePicture: { type: String, trim: true },
    idCard: { type: String, trim: true },
    bankAccount: {
      accountHolder: { type: String, trim: true },
      accountNumber: { type: String, trim: true },
      ifscCode: { type: String, trim: true, uppercase: true },
      bankName: { type: String, trim: true },
      branch: { type: String, trim: true }
    }
  },
  { timestamps: true }
);

partnerSchema.index({ email: 1 }, { sparse: true });

export default mongoose.models.Partner || mongoose.model("Partner", partnerSchema);

