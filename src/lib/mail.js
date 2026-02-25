import nodemailer from "nodemailer";

let transporter;
const configured = () => process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.MAIL_FROM;

const getTransporter = () => {
  if (!configured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
  return transporter;
};

export const sendMail = async ({ to, subject, text, html }) => {
  const t = getTransporter();
  if (!t) return { sent: false, reason: "mail_not_configured" };
  const from = process.env.MAIL_FROM;
  const info = await t.sendMail({ from, to, subject, text, html });
  return { sent: true, messageId: info.messageId };
};

