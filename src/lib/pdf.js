import PDFDocument from "pdfkit";

export const streamInvoicePDF = (res, bill, customer) => {
  const doc = new PDFDocument({ margin: 40 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename=${bill.invoiceNumber}.pdf`);
  doc.pipe(res);
  doc.fontSize(18).text("Invoice", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(12).text(`Invoice No: ${bill.invoiceNumber}`);
  doc.text(`Date: ${new Date(bill.date).toLocaleString()}`);
  doc.moveDown(0.5);
  doc.text(`Customer: ${customer.name}`);
  if (customer.phone) doc.text(`Phone: ${customer.phone}`);
  if (customer.email) doc.text(`Email: ${customer.email}`);
  if (customer.address) doc.text(`Address: ${customer.address}`);
  doc.moveDown(0.5);
  doc.text("Items:");
  doc.moveDown(0.3);
  bill.items.forEach((it, idx) => {
    doc.text(`${idx + 1}. ${it.name} x${it.quantity}  @${it.price}  GST ${it.gst}%  = ${it.lineTotal.toFixed(2)}`);
  });
  doc.moveDown(0.5);
  doc.text(`Subtotal: ${bill.subtotal.toFixed(2)}`);
  doc.text(`GST: ${bill.gstTotal.toFixed(2)}`);
  doc.text(`Total: ${bill.total.toFixed(2)}`);
  if (bill.discount && bill.discount > 0) {
    doc.text(`Discount: -${bill.discount.toFixed(2)}${bill.couponCode ? ` (Coupon ${bill.couponCode})` : ""}`);
    doc.text(`Payable: ${bill.payable.toFixed(2)}`);
  }
  doc.text(`Payment: ${bill.paymentType}`);
  doc.end();
};
