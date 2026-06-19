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
  const h = highlight ? `<div style="margin:24px 0;padding:20px;border:1px solid #e9d5ff;border-radius:16px;background:#f5f3ff;font-weight:800;color:#7c3aed;text-align:center;font-size:18px;letter-spacing:0.02em">${highlight}</div>` : "";
  const b = (blocks || []).map(({ label, value }) => `
    <div style="display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #f1f5f9;">
      <div style="font-size:11px;color:#94a3b8;font-weight:800;letter-spacing:.1em;text-transform:uppercase;">${label}:</div>
      <div style="font-size:14px;color:#1e293b;font-weight:700;text-align:right">${value}</div>
    </div>
  `).join("");
  const irows = Array.isArray(items) && items.length
    ? `
      <div style="margin-top:32px;border:1px solid #f1f5f9;border-radius:16px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.02)">
        <div style="display:flex;background:#f8fafc;border-bottom:1px solid #f1f5f9">
          <div style="flex:6;padding:14px 16px;font-size:10px;color:#64748b;font-weight:800;letter-spacing:.1em;text-transform:uppercase">Product</div>
          <div style="flex:2;padding:14px 16px;font-size:10px;color:#64748b;font-weight:800;letter-spacing:.1em;text-transform:uppercase;text-align:right">Qty</div>
          <div style="flex:4;padding:14px 16px;font-size:10px;color:#64748b;font-weight:800;letter-spacing:.1em;text-transform:uppercase;text-align:right">Total</div>
        </div>
        ${items.map(it => `
          <div style="display:flex;border-top:1px solid #f1f5f9;background:#ffffff">
            <div style="flex:6;padding:14px 16px;font-size:13px;color:#1e293b;font-weight:600">${it.name}</div>
            <div style="flex:2;padding:14px 16px;font-size:13px;color:#1e293b;text-align:right;font-weight:700">${it.quantity}</div>
            <div style="flex:4;padding:14px 16px;font-size:13px;color:#1e293b;text-align:right;font-weight:700">₹${Number(it.lineTotal).toLocaleString("en-IN")}</div>
          </div>
        `).join("")}
        ${totals ? `
          <div style="border-top:2px solid #f1f5f9;background:#fcfcfd;padding:16px">
            <div style="display:flex;justify-content:flex-end;margin-bottom:8px;gap:32px">
              <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:.05em;text-transform:uppercase">Subtotal</div>
              <div style="font-size:14px;color:#475569;font-weight:700">₹${Number(totals.subtotal || 0).toLocaleString("en-IN")}</div>
            </div>
            <div style="display:flex;justify-content:flex-end;margin-bottom:12px;gap:32px">
              <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:.05em;text-transform:uppercase">Tax (GST)</div>
              <div style="font-size:14px;color:#475569;font-weight:700">₹${Number(totals.gstTotal || 0).toLocaleString("en-IN")}</div>
            </div>
            <div style="display:flex;justify-content:flex-end;padding-top:12px;border-top:1px solid #f1f5f9;gap:32px">
              <div style="font-size:12px;color:#1e293b;font-weight:800;letter-spacing:.05em;text-transform:uppercase">Grand Total</div>
              <div style="font-size:20px;color:#7c3aed;font-weight:900">₹${Number(totals.total || 0).toLocaleString("en-IN")}</div>
            </div>
          </div>
        ` : ``}
      </div>
    `
    : "";
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:20px auto;padding:40px;border:1px solid #f1f5f9;border-radius:24px;background:#ffffff;box-shadow:0 20px 40px rgba(0,0,0,0.03)">
      <div style="text-align:center;margin-bottom:32px">
        <div style="font-size:12px;letter-spacing:.3em;color:#7c3aed;background:#f5f3ff;border:1px solid #e9d5ff;display:inline-block;padding:8px 20px;border-radius:100px;font-weight:900;text-transform:uppercase">${company}</div>
      </div>
      <h1 style="margin:0 0 12px;font-size:28px;line-height:1.1;color:#0f172a;font-weight:900;text-align:center;letter-spacing:-0.02em">${heading || ""}</h1>
      <div style="margin:0 0 32px;font-size:15px;color:#64748b;text-align:center;line-height:1.6;font-weight:500">${subheading || ""}</div>
      ${h}
      <div style="margin-top:24px;padding:8px 0">${b}</div>
      ${irows}
      <div style="margin-top:40px;padding:24px;background:#f8fafc;border-radius:16px;color:#64748b;font-size:13px;line-height:1.6;text-align:center;border:1px solid #f1f5f9">
        This is a premium automated message from <strong>${company}</strong>. 
        <br/>If you have any questions, our support team is here to help.
        <br/><br/>Mail us at: <a href="mailto:support@click2kart.net" style="color:#7c3aed;font-weight:700;text-decoration:none">support@click2kart.net</a>
      </div>
      <div style="margin-top:32px;text-align:center;font-size:12px;color:#cbd5e1;font-weight:600;letter-spacing:0.05em">
        © ${year} ${company.toUpperCase()}. ALL RIGHTS RESERVED.
      </div>
    </div>
  `;
};

export const sendOTP = async (email, otp, purpose = "ACCOUNT_VERIFICATION") => {
  const company = process.env.COMPANY_NAME || "Click2Kart";
  const subject =
    purpose === "FORGOT_PASSWORD"
      ? `Reset Your Password - ${company}`
      : purpose === "PARTNER_LOGIN"
      ? `Partner Portal Access OTP - ${company}`
      : purpose === "PARTNER_SIGNUP"
      ? `Partner Application OTP - ${company}`
      : `Email Verification OTP - ${company}`;
  
  const title =
    purpose === "FORGOT_PASSWORD" ? "Reset Password" :
    purpose === "PARTNER_LOGIN" ? "Partner Login" :
    purpose === "PARTNER_SIGNUP" ? "Partner Application" : "Verify Email";

  const intro =
    purpose === "FORGOT_PASSWORD" ? "You requested to reset your password. Use the secure code below." :
    purpose === "PARTNER_LOGIN" ? "Use the one-time password below to access your Partner Dashboard." :
    purpose === "PARTNER_SIGNUP" ? "Use the secure code below to verify your email and complete your partner application." :
    "Use the secure code below to verify your email and complete your setup.";

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; max-width:500px; margin:20px auto; padding:40px; border:1px solid #f1f5f9; border-radius:24px; background:#ffffff; box-shadow:0 20px 40px rgba(0,0,0,0.03); text-align:center;">
      <div style="font-size:12px; letter-spacing:.3em; color:#7c3aed; background:#f5f3ff; border:1px solid #e9d5ff; display:inline-block; padding:8px 20px; border-radius:100px; font-weight:900; text-transform:uppercase; margin-bottom:32px;">${company}</div>
      <h2 style="color:#0f172a; margin:0 0 12px; font-weight:900; font-size:24px; letter-spacing:-0.02em;">${title}</h2>
      <p style="color:#64748b; line-height:1.6; font-size:15px; margin-bottom:32px; font-weight:500;">${intro}</p>
      <div style="background:#0f172a; color:#ffffff; padding:24px; text-align:center; font-size:36px; font-weight:900; letter-spacing:8px; border-radius:20px; box-shadow:0 12px 24px rgba(15,23,42,0.2); margin-bottom:32px;">
        ${otp}
      </div>
      <p style="color:#94a3b8; font-size:13px; font-weight:500; margin-bottom:8px;">Valid for 10 minutes. Do not share this code.</p>
      <p style="color:#94a3b8; font-size:13px; font-weight:500;">If you didn't request this, please ignore this email.</p>
      <hr style="border:none; border-top:1px solid #f1f5f9; margin:32px 0;" />
      <p style="font-size:12px; color:#cbd5e1; font-weight:600; letter-spacing:0.05em;">
        &copy; ${new Date().getFullYear()} ${company.toUpperCase()}. ALL RIGHTS RESERVED.
      </p>
    </div>
  `;
  return sendEmail({ to: email, subject, html });
};

export const sendPartnerWelcome = async (partner) => {
  const company = process.env.COMPANY_NAME || "Click2Kart";
  const subject = `Welcome to ${company} Partner Program`;
  const baseUrl =
    (process.env.CLIENT_URL && process.env.CLIENT_URL.replace(/\/$/, "")) ||
    "https://click2kart.net";
  
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; max-width:560px; margin:20px auto; padding:40px; border:1px solid #f1f5f9; border-radius:24px; background:#ffffff; box-shadow:0 20px 40px rgba(0,0,0,0.03);">
      <div style="text-align:center; margin-bottom:32px;">
        <div style="font-size:12px; letter-spacing:.3em; color:#7c3aed; background:#f5f3ff; border:1px solid #e9d5ff; display:inline-block; padding:8px 20px; border-radius:100px; font-weight:900; text-transform:uppercase; margin-bottom:24px;">${company} PARTNER</div>
        <h1 style="margin:0 0 12px; font-size:32px; color:#0f172a; font-weight:900; letter-spacing:-0.02em;">Welcome Aboard, ${partner.name || 'Partner'}!</h1>
        <p style="color:#64748b; line-height:1.7; font-size:15px; margin:0;">
          Your partner account has been created and is ready to use.
        </p>
      </div>

      <div style="background:#f8fafc; border:1px solid #f1f5f9; border-radius:16px; padding:24px; margin-bottom:24px;">
        <div style="display:flex; justify-content:space-between; padding:12px 0; border-bottom:1px solid #f1f5f9;">
          <div style="font-size:11px; color:#94a3b8; font-weight:800; letter-spacing:.1em; text-transform:uppercase;">Name:</div>
          <div style="font-size:14px; color:#1e293b; font-weight:700;">${partner.name}</div>
        </div>
        ${partner.email ? `
        <div style="display:flex; justify-content:space-between; padding:12px 0; border-bottom:1px solid #f1f5f9;">
          <div style="font-size:11px; color:#94a3b8; font-weight:800; letter-spacing:.1em; text-transform:uppercase;">Email:</div>
          <div style="font-size:14px; color:#1e293b; font-weight:700;">${partner.email}</div>
        </div>
        ` : ''}
        ${partner.phone ? `
        <div style="display:flex; justify-content:space-between; padding:12px 0;">
          <div style="font-size:11px; color:#94a3b8; font-weight:800; letter-spacing:.1em; text-transform:uppercase;">Phone:</div>
          <div style="font-size:14px; color:#1e293b; font-weight:700;">${partner.phone}</div>
        </div>
        ` : ''}
      </div>

      <div style="text-align:center; margin-bottom:24px;">
        <a href="${baseUrl}/partner/login" style="display:inline-block; padding:16px 32px; background:linear-gradient(135deg,#7c3aed,#6366f1); color:#fff; text-decoration:none; border-radius:14px; font-weight:800; font-size:14px; box-shadow:0 10px 20px rgba(124,58,237,0.3);">
          Login to Partner Dashboard
        </a>
      </div>

      <div style="margin:32px 0; padding:24px; background:#f5f3ff; border:1px solid #e9d5ff; border-radius:16px; text-align:center;">
        <h3 style="margin:0 0 12px; color:#7c3aed; font-size:16px; font-weight:800;">What's Next?</h3>
        <ul style="list-style:none; padding:0; margin:0; text-align:left; color:#64748b; font-size:14px; line-height:1.8;">
          <li style="padding:8px 0; border-bottom:1px solid #e9d5ff;">&bull; Complete your profile and bank details</li>
          <li style="padding:8px 0; border-bottom:1px solid #e9d5ff;">&bull; Get your unique referral coupon codes</li>
          <li style="padding:8px 0;">&bull; Start referring businesses and earn commissions!</li>
        </ul>
      </div>

      <div style="margin-top:32px; text-align:center; color:#94a3b8; font-size:13px; line-height:1.6;">
        If you have any questions, our support team is here to help.
        <br/>Mail us at: <a href="mailto:support@click2kart.net" style="color:#7c3aed;font-weight:700;text-decoration:none">support@click2kart.net</a>
        <br/><br/>
        &copy; ${new Date().getFullYear()} ${company.toUpperCase()}. ALL RIGHTS RESERVED.
      </div>
    </div>
  `;
  
  if (partner.email) {
    return sendEmail({ to: partner.email, subject, html });
  }
};

export const sendPartnerCoupon = async (partner, coupon) => {
  const company = process.env.COMPANY_NAME || "Click2Kart";
  const subject = `New Coupon Code Assigned - ${coupon.code}`;
  
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; max-width:560px; margin:20px auto; padding:40px; border:1px solid #f1f5f9; border-radius:24px; background:#ffffff; box-shadow:0 20px 40px rgba(0,0,0,0.03);">
      <div style="text-align:center; margin-bottom:32px;">
        <div style="font-size:12px; letter-spacing:.3em; color:#7c3aed; background:#f5f3ff; border:1px solid #e9d5ff; display:inline-block; padding:8px 20px; border-radius:100px; font-weight:900; text-transform:uppercase; margin-bottom:24px;">${company} PARTNER</div>
        <h1 style="margin:0 0 12px; font-size:32px; color:#0f172a; font-weight:900; letter-spacing:-0.02em;">New Coupon Code!</h1>
        <p style="color:#64748b; line-height:1.7; font-size:15px; margin:0;">
          A new coupon has been assigned to you. Share it to earn commissions!
        </p>
      </div>

      <div style="background:linear-gradient(135deg,#0f172a,#1e293b); border-radius:20px; padding:32px; text-align:center; margin-bottom:32px;">
        <div style="font-size:11px; letter-spacing:.2em; color:#94a3b8; text-transform:uppercase; font-weight:800; margin-bottom:12px;">Your Coupon Code</div>
        <div style="font-size:40px; font-weight:900; color:#fff; letter-spacing:6px; margin-bottom:16px;">${coupon.code}</div>
        <div style="display:flex; justify-content:center; gap:16px; flex-wrap:wrap;">
          <div style="text-align:center;">
            <div style="font-size:11px; color:#94a3b8; font-weight:700; text-transform:uppercase; letter-spacing:.1em;">Commission</div>
            <div style="font-size:20px; font-weight:900; color:#22c55e;">${coupon.partnerCommissionPercent || 0}%</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:11px; color:#94a3b8; font-weight:700; text-transform:uppercase; letter-spacing:.1em;">Type</div>
            <div style="font-size:20px; font-weight:900; color:#eab308;">${coupon.type}</div>
          </div>
          ${coupon.expiryDate ? `
          <div style="text-align:center;">
            <div style="font-size:11px; color:#94a3b8; font-weight:700; text-transform:uppercase; letter-spacing:.1em;">Expires</div>
            <div style="font-size:20px; font-weight:900; color:#f87171;">${new Date(coupon.expiryDate).toLocaleDateString()}</div>
          </div>
          ` : ''}
        </div>
      </div>

      <div style="background:#f8fafc; border:1px solid #f1f5f9; border-radius:16px; padding:24px; margin-bottom:24px;">
        <h3 style="margin:0 0 12px; color:#1e293b; font-size:16px; font-weight:800;">Coupon Details</h3>
        <div style="display:flex; justify-content:space-between; padding:12px 0; border-bottom:1px solid #f1f5f9;">
          <div style="font-size:11px; color:#94a3b8; font-weight:800; letter-spacing:.1em; text-transform:uppercase;">Discount:</div>
          <div style="font-size:14px; color:#1e293b; font-weight:700;">${coupon.type === 'PERCENT' ? coupon.value + '%' : '₹' + coupon.value}</div>
        </div>
        ${coupon.minOrderValue ? `
        <div style="display:flex; justify-content:space-between; padding:12px 0; border-bottom:1px solid #f1f5f9;">
          <div style="font-size:11px; color:#94a3b8; font-weight:800; letter-spacing:.1em; text-transform:uppercase;">Min Order:</div>
          <div style="font-size:14px; color:#1e293b; font-weight:700;">₹${coupon.minOrderValue}</div>
        </div>
        ` : ''}
        ${coupon.maxDiscount ? `
        <div style="display:flex; justify-content:space-between; padding:12px 0;">
          <div style="font-size:11px; color:#94a3b8; font-weight:800; letter-spacing:.1em; text-transform:uppercase;">Max Discount:</div>
          <div style="font-size:14px; color:#1e293b; font-weight:700;">₹${coupon.maxDiscount}</div>
        </div>
        ` : ''}
      </div>

      <div style="margin-top:32px; text-align:center; color:#94a3b8; font-size:13px; line-height:1.6;">
        Share this coupon with your referrals to start earning commissions on every sale!
        <br/>If you have any questions, mail us at: <a href="mailto:support@click2kart.net" style="color:#7c3aed;font-weight:700;text-decoration:none">support@click2kart.net</a>
        <br/><br/>
        &copy; ${new Date().getFullYear()} ${company.toUpperCase()}. ALL RIGHTS RESERVED.
      </div>
    </div>
  `;
  
  const emailToSend = partner.email || coupon.partnerEmail;
  if (emailToSend) {
    return sendEmail({ to: emailToSend, subject, html });
  }
};
