import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: process.env.SMTP_PORT || 587,
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

export const sendEmail = async ({ to, subject, text, html }) => {
  try {
    const info = await transporter.sendMail({
      from: `"${process.env.COMPANY_NAME || "Click2Kart"}" <${process.env.SMTP_USER}>`,
      to,
      subject,
      text,
      html
    });
    return info;
  } catch (error) {
    console.error("Email sending failed:", error);
    throw error;
  }
};

export const sendOTP = async (email, otp) => {
  const subject = "Verification OTP - Click2Kart";
  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
      <h2 style="color: #2563eb; text-align: center;">Click2Kart</h2>
      <p>Hello,</p>
      <p>Your verification OTP is:</p>
      <div style="background: #f3f4f6; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #111827; border-radius: 8px;">
        ${otp}
      </div>
      <p style="margin-top: 20px;">This 4-digit OTP is valid for 10 minutes. Do not share this with anyone.</p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
      <p style="font-size: 12px; color: #6b7280; text-align: center;">
        &copy; ${new Date().getFullYear()} Click2Kart Premium. All rights reserved.
      </p>
    </div>
  `;
  return sendEmail({ to: email, subject, html });
};
