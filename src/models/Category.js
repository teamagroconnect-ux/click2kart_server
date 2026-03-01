import mongoose from "mongoose";

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, lowercase: true },
    description: { type: String, default: "" },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: "Category", default: null },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

categorySchema.index({ name: 1 }, { unique: true });

export default mongoose.models.Category || mongoose.model("Category", categorySchema);
