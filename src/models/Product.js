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
    hsnCode: { type: String, default: "" },
    category: { type: String, index: true },
    subcategory: { type: String, index: true },
    images: { type: [imageSchema], default: [] },
    stock: { type: Number, required: true, min: 0 },
    gst: { type: Number, default: 0, min: 0 },
    mrp: { type: Number, min: 0 },
    bulkDiscountQuantity: { type: Number, default: 0, min: 0 },
    bulkDiscountPriceReduction: { type: Number, default: 0, min: 0 },
    bulkTiers: {
      type: [
        {
          quantity: { type: Number, min: 1 },
          priceReduction: { type: Number, min: 0 }
        }
      ],
      default: []
    },
    variants: {
      type: [
        {
          _id: { type: mongoose.Schema.Types.ObjectId, default: () => new mongoose.Types.ObjectId() },
          attributes: {
            color: { type: String, default: "" },
            ram: { type: String, default: "" },
            storage: { type: String, default: "" },
            capacity: { type: String, default: "" }
          },
          price: { type: Number, min: 0 },
          mrp: { type: Number, min: 0 },
          stock: { type: Number, min: 0, default: 0 },
          sku: { type: String },
          isActive: { type: Boolean, default: true },
          images: { type: [imageSchema], default: [] }
        }
      ],
      default: []
    },
    isActive: { type: Boolean, default: true },
    isVerified: { type: Boolean, default: true },
    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 }
  },
  { timestamps: true }
);

productSchema.index({ name: "text", description: "text", category: "text", subcategory: "text" }, { weights: { name: 10, category: 5, subcategory: 4, description: 2 } });
productSchema.index({ isActive: 1, category: 1, createdAt: -1 });
productSchema.index({ isActive: 1, stock: 1 });

export default mongoose.models.Product || mongoose.model("Product", productSchema);
