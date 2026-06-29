import mongoose from "mongoose";

const settingsSchema = new mongoose.Schema(
  {
    companyName: { type: String, default: "Click2Kart" },
    companyGst: { type: String, default: "" },
    companyAddress: { type: String, default: "" },
    companyPhone: { type: String, default: "" },
    companyEmail: { type: String, default: "" },
    // Pickup address fields
    pickupName: { type: String, default: "" },
    pickupLine1: { type: String, default: "" },
    pickupLine2: { type: String, default: "" },
    pickupCity: { type: String, default: "" },
    pickupState: { type: String, default: "" },
    pickupPincode: { type: String, default: "" },
    pickupCountry: { type: String, default: "India" },
    pickupPhone: { type: String, default: "" },
    lowStockThreshold: { type: Number, default: 5 },
    minimumOrderAmount: { type: Number, default: 5000 },
    currency: { type: String, default: "INR" },
    taxRate: { type: Number, default: 18 },
    shippingFee: { type: Number, default: 0 },
    enableBirthdayWishes: { type: Boolean, default: true },
    enableOrderNotifications: { type: Boolean, default: true },
    supportPhone: { type: String, default: "" },
    supportEmail: { type: String, default: "" },
    returnPolicy: { type: String, default: "" },
    termsOfService: { type: String, default: "" },
    privacyPolicy: { type: String, default: "" }
  },
  { timestamps: true }
);

// Create default settings if none exist
settingsSchema.statics.getDefaultSettings = async function () {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({});
  }
  return settings;
};

export default mongoose.models.Settings || mongoose.model("Settings", settingsSchema);
