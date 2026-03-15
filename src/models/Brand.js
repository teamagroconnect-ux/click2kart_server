import mongoose from "mongoose";

const brandSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    logo: { type: String, default: "" },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

brandSchema.index({ name: 1 });
brandSchema.index({ slug: 1 });

export default mongoose.models.Brand || mongoose.model("Brand", brandSchema);
