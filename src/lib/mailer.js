import axios from "axios";
  
async function getAccessToken() {
  const res = await axios.post("https://accounts.zoho.in/oauth/v2/token", null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: "refresh_token"
    }
  });
  return res.data.access_token;
}

export const sendEmail = async ({ to, subject, text, html }) => {
  const content = html || (text ? `<pre>${text}</pre>` : "");
  try {
    const accessToken = await getAccessToken();
    await axios.post(
      `https://mail.zoho.in/api/accounts/${process.env.ZOHO_ACCOUNT_ID}/messages`,
      {
        fromAddress: `${process.env.MAIL_FROM_NAME || process.env.COMPANY_NAME || "Click2Kart"} <${process.env.ZOHO_MAIL_FROM}>`,
        toAddress: to,
        subject,
        content
      },
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`
        }
      }
    );
    return { sent: true };
  } catch (err) {
    const detail = err?.response?.data || err.message;
    console.error("Email sending failed:", detail);
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
};

export const renderMail = ({ heading, subheading, blocks, highlight, items, totals }) => {
  const company = process.env.COMPANY_NAME || "Click2Kart";
  const year = new Date().getFullYear();
  const h = highlight ? `<div style="margin:12px 0;padding:14px 16px;border:1px solid #e5e7eb;border-radius:12px;background:#f9fafb;font-weight:700;color:#111827">${highlight}</div>` : "";
  const b = (blocks || []).map(({ label, value }) => `
    <div style="display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px dashed #e5e7eb">
      <div style="font-size:12px;color:#6b7280;font-weight:700;letter-spacing:.08em;text-transform:uppercase">${label}</div>
      <div style="font-size:14px;color:#111827;font-weight:700;text-align:right">${value}</div>
    </div>
  `).join("");
  const irows = Array.isArray(items) && items.length
    ? `
      <div style="margin-top:14px;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
        <div style="display:flex;background:#f9fafb;border-bottom:1px solid #e5e7eb">
          <div style="flex:6;padding:10px 12px;font-size:11px;color:#6b7280;font-weight:800;letter-spacing:.08em;text-transform:uppercase">Item</div>
          <div style="flex:2;padding:10px 12px;font-size:11px;color:#6b7280;font-weight:800;letter-spacing:.08em;text-transform:uppercase;text-align:right">Qty</div>
          <div style="flex:3;padding:10px 12px;font-size:11px;color:#6b7280;font-weight:800;letter-spacing:.08em;text-transform:uppercase;text-align:right">Unit</div>
          <div style="flex:3;padding:10px 12px;font-size:11px;color:#6b7280;font-weight:800;letter-spacing:.08em;text-transform:uppercase;text-align:right">Total</div>
        </div>
        ${items.map(it => `
          <div style="display:flex;border-top:1px solid #f1f5f9">
            <div style="flex:6;padding:10px 12px;font-size:13px;color:#111827;font-weight:600">${it.name}</div>
            <div style="flex:2;padding:10px 12px;font-size:13px;color:#111827;text-align:right">${it.quantity}</div>
            <div style="flex:3;padding:10px 12px;font-size:13px;color:#111827;text-align:right">₹${Number(it.price).toLocaleString("en-IN")}</div>
            <div style="flex:3;padding:10px 12px;font-size:13px;color:#111827;text-align:right">₹${Number(it.lineTotal).toLocaleString("en-IN")}</div>
          </div>
        `).join("")}
        ${totals ? `
          <div style="border-top:1px solid #e5e7eb;background:#fafafa">
            <div style="display:flex;justify-content:flex-end;padding:10px 12px;gap:24px">
              <div style="font-size:12px;color:#6b7280;font-weight:800;letter-spacing:.08em;text-transform:uppercase">Subtotal</div>
              <div style="font-size:14px;color:#111827;font-weight:800">₹${Number(totals.subtotal || 0).toLocaleString("en-IN")}</div>
            </div>
            <div style="display:flex;justify-content:flex-end;padding:6px 12px;gap:24px">
              <div style="font-size:12px;color:#6b7280;font-weight:800;letter-spacing:.08em;text-transform:uppercase">GST</div>
              <div style="font-size:14px;color:#111827;font-weight:800">₹${Number(totals.gstTotal || 0).toLocaleString("en-IN")}</div>
            </div>
            <div style="display:flex;justify-content:flex-end;padding:10px 12px;gap:24px">
              <div style="font-size:12px;color:#6b7280;font-weight:800;letter-spacing:.08em;text-transform:uppercase">Total</div>
              <div style="font-size:16px;color:#111827;font-weight:900">₹${Number(totals.total || 0).toLocaleString("en-IN")}</div>
            </div>
          </div>
        ` : ``}
      </div>
    `
    : "";
  return `
    <div style="font-family:ui-sans-serif,system-ui;-webkit-font-smoothing:antialiased;max-width:680px;margin:auto;padding:28px;border:1px solid #e5e7eb;border-radius:20px;background:#ffffff">
      <div style="text-align:center;margin-bottom:16px">
        <div style="font-size:11px;letter-spacing:.2em;color:#7c3aed;background:#f5f3ff;border:1px solid #e9d5ff;display:inline-block;padding:6px 12px;border-radius:999px;font-weight:800;text-transform:uppercase">${company}</div>
      </div>
      <h1 style="margin:0 0 6px;font-size:22px;line-height:1.2;color:#111827">${heading || ""}</h1>
      <div style="margin:0 0 12px;font-size:13px;color:#6b7280">${subheading || ""}</div>
      ${h}
      <div style="margin-top:6px">${b}</div>
      ${irows}
      <div style="margin-top:18px;padding:14px 16px;border:1px solid #eef2ff;background:#f8fafc;border-radius:12px;color:#475569;font-size:12px">
        This is an automated message from ${company}. For any queries, reply to this email.
      </div>
      <div style="margin-top:20px;text-align:center;font-size:11px;color:#9ca3af">
        © ${year} ${company}. All rights reserved.
      </div>
    </div>
  `;
};

export const sendOTP = async (email, otp, purpose = "ACCOUNT_VERIFICATION") => {
  const company = process.env.COMPANY_NAME || "Click2Kart";
  const subject =
    purpose === "FORGOT_PASSWORD"
      ? `Password Reset OTP - ${company}`
      : `Verification OTP - ${company}`;
  const title =
    purpose === "FORGOT_PASSWORD"
      ? "Reset Your Password"
      : "Verify Your Email";
  const intro =
    purpose === "FORGOT_PASSWORD"
      ? "You requested to reset your password. Use the OTP below to proceed."
      : "Use the OTP below to verify your email address and complete account setup.";
  const cta =
    purpose === "FORGOT_PASSWORD"
      ? "If you did not request this, you can safely ignore this email."
      : "If you did not initiate this request, you can ignore this email.";
  const html = `
    <div style="font-family: ui-sans-serif, system-ui; max-width: 640px; margin: auto; padding: 24px; border: 1px solid #eee; border-radius: 14px;">
      <h2 style="color: #111827; text-align: center; margin: 0 0 8px; font-weight: 800;">${company}</h2>
      <div style="text-align:center; color:#6b7280; font-size:14px; margin-bottom:12px">${title}</div>
      <p style="color:#374151; line-height:1.7">${intro}</p>
      <div style="background: #111827; color:#fff; padding: 18px; text-align: center; font-size: 32px; font-weight: 900; letter-spacing: 6px; border-radius: 12px;">
        ${otp}
      </div>
      <p style="margin-top: 14px; color:#6b7280">This 4-digit OTP is valid for 10 minutes. Do not share it with anyone.</p>
      <p style="margin-top: 6px; color:#6b7280">${cta}</p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
      <p style="font-size: 12px; color: #6b7280; text-align: center;">
        &copy; ${new Date().getFullYear()} ${company}. All rights reserved.
      </p>
    </div>
  `;
  return sendEmail({ to: email, subject, html });
};
