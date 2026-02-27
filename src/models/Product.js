import mongoose from "mongoose";

const imageSchema = new mongoose.Schema({
  url: { type: String, required: true },
  publicId: { type: String }
});

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    price: { type: Number, required: true, min: 0 },
    category: { type: String, index: true },
    images: { type: [imageSchema], default: [] },
    stock: { type: Number, required: true, min: 0 },
    gst: { type: Number, default: 0, min: 0 },
    bulkDiscountQuantity: { type: Number, default: 0, min: 0 },
    bulkDiscountPriceReduction: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 }
  },
  { timestamps: true }
);

export default mongoose.models.Product || mongoose.model("Product", productSchema);
