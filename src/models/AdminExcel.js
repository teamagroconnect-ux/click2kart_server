import mongoose from "mongoose";

const adminExcelSchema = new mongoose.Schema(
  {
    data: { type: [[mongoose.Schema.Types.Mixed]], default: [["Item", "Quantity", "Price", "Total"], ["", "", "", ""]] },
    fileName: { type: String, default: "admin-data" }
  },
  { timestamps: true }
);

// Get or create default excel data
adminExcelSchema.statics.getDefaultExcel = async function () {
  let excel = await this.findOne();
  if (!excel) {
    excel = await this.create({});
  }
  return excel;
};

export default mongoose.models.AdminExcel || mongoose.model("AdminExcel", adminExcelSchema);
