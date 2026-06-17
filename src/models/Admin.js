import mongoose from "mongoose";
import bcrypt from "bcrypt";

const adminSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6 },
    deletionPassword: { type: String, default: "admin123", minlength: 6 }, // Default deletion password
    role: { type: String, enum: ["admin", "staff"], default: "admin" },
    permissions: { type: [String], default: [] }, // Array of accessible component IDs or route names
    isActive: { type: Boolean, default: true },
    lastLogin: { type: Date }
  },
  { timestamps: true }
);

adminSchema.pre("save", async function (next) {
  if (this.isModified("password")) {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  }
  // Hash deletion password if modified or new
  if (this.isModified("deletionPassword") || this.isNew) {
    const salt = await bcrypt.genSalt(10);
    this.deletionPassword = await bcrypt.hash(this.deletionPassword, salt);
  }
  next();
});

adminSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

adminSchema.methods.compareDeletionPassword = function (candidate) {
  return bcrypt.compare(candidate, this.deletionPassword);
};

export default mongoose.models.Admin || mongoose.model("Admin", adminSchema);

