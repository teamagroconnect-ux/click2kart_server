import mongoose from "mongoose";
import bcrypt from "bcrypt";

const generateInviteCode = () => {
  return Math.floor(1000 + Math.random() * 9000).toString();
};

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
    inviteCode: { type: String, trim: true, unique: true },
    businessName: { type: String, trim: true },
    gstNumber: { type: String, trim: true, uppercase: true },
    panNumber: { type: String, trim: true, uppercase: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    district: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    bloodGroup: { type: String, trim: true, uppercase: true },
    dob: { type: Date },
    profilePicture: { type: String, trim: true },
    idCard: { type: String, trim: true },
    panCard: { type: String, default: "" },
    aadhaarCard: { type: String, default: "" },
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

partnerSchema.pre("save", async function (next) {
  if (!this.inviteCode) {
    let code;
    let isUnique = false;
    while (!isUnique) {
      code = generateInviteCode();
      const existing = await mongoose.models.Partner?.findOne({ inviteCode: code });
      if (!existing) isUnique = true;
    }
    this.inviteCode = code;
  }
  
  if (!this.isModified("password")) return next();
  if (!this.password) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

partnerSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

export default mongoose.models.Partner || mongoose.model("Partner", partnerSchema);

