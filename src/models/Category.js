import mongoose from "mongoose";

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, lowercase: true },
    description: { type: String, default: "" },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

categorySchema.index({ name: 1 }, { unique: true });

export default mongoose.models.Category || mongoose.model("Category", categorySchema);

