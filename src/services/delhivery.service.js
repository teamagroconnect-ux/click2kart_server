import fetch from "node-fetch";

const _sanitize = (s) => String(s || "").trim().replace(/^['"`]+|['"`]+$/g, "").replace(/\/+$/, "");
const ltlBase = () => _sanitize(process.env.DELHIVERY_LTL_BASE_URL || "");
const legacyBase = () => _sanitize(process.env.DELHIVERY_BASE_URL || "");
const token = () => String(process.env.DELHIVERY_API_TOKEN || process.env.DELHIVERY_TOKEN || "");
const authHeader = () => ({ Authorization: `Token ${token()}` });

export const checkServiceability = async (pincode) => {
  const ltl = ltlBase();
  const legacy = legacyBase();
  if (!ltl && !legacy) throw new Error("delhivery_not_configured");
  if (ltl) {
    try {
      const r = await fetch(`${ltl}/pincode-service/${encodeURIComponent(pincode)}`, { headers: authHeader() });
      if (r.ok) {
        const json = await r.json();
        console.log("Delhivery LTL:", json);
        const svc = json?.data || json || {};
        const delivery_available = !!(svc.serviceable ?? svc.is_serviceable ?? svc.delivery ?? svc.pre_paid);
        const cod_available = !!(svc.cod ?? svc.cod_serviceable ?? svc.cash);
        return { pincode, delivery_available, cod_available };
      }
    } catch {}
  }
  if (legacy) {
    const url = `${legacy}/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(pincode)}`;
    const r2 = await fetch(url, { headers: authHeader() });
    const json = await r2.json();
    console.log("Delhivery Legacy:", json);
    let delivery_available = false, cod_available = false;
    if (Array.isArray(json)) {
      const entry = json.find((x) => String(x.pin) === String(pincode));
      delivery_available = !!(entry?.is_oda === false || entry?.pre_paid || entry?.delivery || entry?.serviceable);
      cod_available = !!(entry?.cod || entry?.cash || entry?.cod_serviceable);
    } else {
      const entry = json?.delivery_codes?.[0] || null;
      delivery_available = !!(entry?.is_oda === false || entry?.pre_paid || entry?.delivery || entry?.serviceable);
      cod_available = !!(entry?.cod || entry?.cash || entry?.cod_serviceable);
    }
    return { pincode, delivery_available, cod_available };
  }
  throw new Error("serviceability_failed");
};

export const estimateFreight = async (payload) => {
  const b = ltlBase() || legacyBase();
  if (!b) throw new Error("delhivery_not_configured");
  const r = await fetch(`${b}/freight/estimate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(payload || {})
  });
  const d = await r.json();
  return d;
};

export const createShipment = async (manifestPayload) => {
  const b = ltlBase() || legacyBase();
  if (!b) throw new Error("delhivery_not_configured");
  const r = await fetch(`${b}/manifest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(manifestPayload || {})
  });
  const d = await r.json();
  return d;
};

export const getManifestStatus = async (jobId) => {
  const b = ltlBase() || legacyBase();
  if (!b) throw new Error("delhivery_not_configured");
  const r = await fetch(`${b}/manifest?job_id=${encodeURIComponent(jobId)}`, { headers: authHeader() });
  const d = await r.json();
  return d;
};

export const trackShipment = async (lrn) => {
  const b = ltlBase() || legacyBase();
  if (!b) throw new Error("delhivery_not_configured");
  const r = await fetch(`${b}/lrn/track?lrn=${encodeURIComponent(lrn)}`, { headers: authHeader() });
  const d = await r.json();
  return d;
};
