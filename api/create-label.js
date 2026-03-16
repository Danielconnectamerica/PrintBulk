// /api/create-label.js
// USPS Returns (Pay-On-Use) label via Stamps.com/Endicia SERA
// Physical-mail version: intentionally does NOT capture or log email fields.

const SIGNIN_BASE = process.env.SERA_SIGNIN_BASE || "https://signin.stampsendicia.com";
const API_BASE = process.env.SERA_API_BASE || "https://api.stampsendicia.com/sera";

const CLIENT_ID = process.env.SERA_CLIENT_ID;
const CLIENT_SECRET = process.env.SERA_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.SERA_REFRESH_TOKEN;

const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || "";

// Hardcoded returns warehouse (destination)
const RETURN_TO = {
  name: "Return Warehouse",
  company_name: "Lifeline Returns",
  address_line1: "110 Southchase Blvd",
  address_line2: "",
  city: "Fountain Inn",
  state_province: "SC",
  postal_code: "29644",
  country_code: "US",
  phone: "8002862622",
  email: "",
};

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

async function postToSheets(webhookUrl, payload) {
  if (!webhookUrl) return null;

  try {
    const r = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function getAccessToken() {
  const url = `${SIGNIN_BASE.replace(/\/+$/, "")}/oauth/token`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
    }),
  });

  const data = await resp.json().catch(() => null);

  if (!resp.ok || !data?.access_token) {
    throw new Error(`Token refresh failed. HTTP ${resp.status} ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

function todayYYYYMMDD() {
  return new Date().toISOString().slice(0, 10);
}

function uuidv4() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const { randomUUID } = require("crypto");
  return randomUUID();
}

function customerFromAddress(body) {
  return {
    name: String(body.name || "").trim(),
    company_name: "",
    address_line1: String(body.address1 || "").trim(),
    address_line2: String(body.address2 || "").trim(),
    city: String(body.city || "").trim(),
    state_province: String(body.state || "").trim(),
    postal_code: String(body.zip || "").trim(),
    country_code: "US",
    phone: String(body.phone || "").trim(),
    // Intentionally no email field for physical-mail flow
    email: "",
  };
}

function normalizeWeightOz(body) {
  // Prefer weightOz from UI; fallback to weightLbs; then default 32 oz
  const oz = Number(body.weightOz);
  if (Number.isFinite(oz) && oz > 0) return oz;

  const lbs = Number(body.weightLbs);
  if (Number.isFinite(lbs) && lbs > 0) return lbs * 16;

  return 32;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { ok: false, error: "Method Not Allowed" });
    }

    if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
      return json(res, 500, {
        ok: false,
        error: "Missing env vars: SERA_CLIENT_ID, SERA_CLIENT_SECRET, SERA_REFRESH_TOKEN.",
      });
    }

    const body = typeof req.body === "string"
      ? JSON.parse(req.body || "{}")
      : (req.body || {});

    // Allow caller to skip SharePoint/webhook logging
    const skipLogging = body?.skipLogging === true;

    const required = ["name", "address1", "city", "state", "zip", "phone", "deviceType"];
    const missing = required.filter((k) => !String(body[k] || "").trim());

    if (missing.length) {
      return json(res, 400, {
        ok: false,
        error: `Missing required fields: ${missing.join(", ")}`
      });
    }

    const from_address = customerFromAddress(body);

    if (
      !from_address.name ||
      !from_address.address_line1 ||
      !from_address.city ||
      !from_address.state_province ||
      !from_address.postal_code
    ) {
      return json(res, 400, {
        ok: false,
        error: "From address incomplete (name, address, city, state, zip required).",
      });
    }

    const weightOz = normalizeWeightOz(body);
    const accessToken = await getAccessToken();

    const payload = {
      from_address,
      ship_from_address: from_address,
      sender_address: from_address,

      to_address: RETURN_TO,
      return_address: RETURN_TO,

      service_type: "usps_ground_advantage",
      ship_date: todayYYYYMMDD(),
      is_return_label: true,

      package: {
        packaging_type: "package",
        weight: weightOz,
        weight_unit: "ounce",
      },

      advanced_options: {
        is_pay_on_use: true,
      },

      label_options: {
        label_size: "4x6",
        label_format: "pdf",
        label_output_type: "base64",
      },

      references: {
        reference1: String(body.deviceSerial || "").trim(),
        reference2: String(body.returnReason || "").trim(),
      },

      is_test_label: false,
    };

    const idempotencyKey = uuidv4();

    const labelResp = await fetch(`${API_BASE.replace(/\/+$/, "")}/v1/labels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
    });

    const labelData = await labelResp.json().catch(() => null);

    if (!labelResp.ok) {
      return json(res, labelResp.status || 500, {
        ok: false,
        error: "Label creation failed",
        httpStatus: labelResp.status,
        details: labelData,
      });
    }

    const trackingNumber = labelData.tracking_number || "";
    const maybeBase64 = labelData.labels?.[0]?.label_data || labelData.label_data || null;

    let sheetsLogged = null;

    if (!skipLogging) {
      const sheetsPayload = {
        request_id: idempotencyKey,
        source: "Lifeline Print",
        created_at_iso: new Date().toISOString(),

        customer_name: from_address.name,
        customer_phone: from_address.phone,
        from_address1: from_address.address_line1,
        from_address2: from_address.address_line2,
        from_city: from_address.city,
        from_state: from_address.state_province,
        from_zip: from_address.postal_code,

        device_type: String(body.deviceType || ""),
        device_serial: String(body.deviceSerial || ""),
        return_reason: String(body.returnReason || ""),
        weight_oz: weightOz,

        service_type: labelData.service_type || "usps_ground_advantage",
        tracking_number: trackingNumber,
        label_id: labelData.label_id || "",
        postage_total_usd: labelData?.shipment_cost?.total_amount ?? null,

        status: "Created",
      };

      sheetsLogged = await postToSheets(SHEETS_WEBHOOK_URL, sheetsPayload);
    }

    if (maybeBase64) {
      return json(res, 200, {
        ok: true,
        trackingNumber,
        filename: "usps-pay-on-use-return-label.pdf",
        mimeType: "application/pdf",
        labelData: maybeBase64,
        sheetsLogged,
      });
    }

    const labelHref = labelData.labels?.[0]?.href || "";
    if (labelHref) {
      const fileResp = await fetch(labelHref, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const buf = Buffer.from(await fileResp.arrayBuffer());
      const base64 = buf.toString("base64");

      return json(res, 200, {
        ok: true,
        trackingNumber,
        filename: "usps-pay-on-use-return-label.pdf",
        mimeType: "application/pdf",
        labelData: base64,
        sheetsLogged,
      });
    }

    return json(res, 500, {
      ok: false,
      error: "Label created but no label data returned (unexpected response shape).",
      raw: labelData,
      sheetsLogged,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e) });
  }
};
