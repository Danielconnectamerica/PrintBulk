// /api/bulk-mail-label.js
// Bulk physical return label mailer
// - Accepts { batchName, rows: [...] }
// - Validates shared password via x-bulk-password
// - Internally calls /api/mail-label with MAIL_USER / MAIL_PASS Basic Auth
// - Processes rows one-by-one
// - Intentionally ignores email fields
// - Optionally logs final mailed result to SharePoint / Power Automate webhook

const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || "";

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host;
  return `${proto}://${host}`;
}

function requireField(body, key) {
  const v = body?.[key];
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s;
}

function normalizeWeightOz(body) {
  const oz = Number(body?.weightOz);
  if (Number.isFinite(oz) && oz > 0) return oz;

  const lbs = Number(body?.weightLbs);
  if (Number.isFinite(lbs) && lbs > 0) return lbs * 16;

  return null;
}

function sanitizeRow(row) {
  return {
    name: requireField(row, "name"),
    address1: requireField(row, "address1"),
    address2: requireField(row, "address2") || "",
    city: requireField(row, "city"),
    state: requireField(row, "state"),
    zip: requireField(row, "zip"),
    phone: requireField(row, "phone"),
    deviceType: requireField(row, "deviceType"),
    deviceSerial: requireField(row, "deviceSerial") || "",
    returnReason: requireField(row, "returnReason") || "",
    weightOz: normalizeWeightOz(row),
  };
}

function validateRow(row) {
  const missing = [];
  if (!row.name) missing.push("name");
  if (!row.address1) missing.push("address1");
  if (!row.city) missing.push("city");
  if (!row.state) missing.push("state");
  if (!row.zip) missing.push("zip");
  if (!row.phone) missing.push("phone");
  if (!row.deviceType) missing.push("deviceType");

  return {
    ok: missing.length === 0,
    missing,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
    }

    const sharedPassword = req.headers["x-bulk-password"] || "";
    const expectedPassword = process.env.MAIL_PASS || "";

    if (!expectedPassword) {
      return sendJson(res, 500, {
        ok: false,
        error: "Missing MAIL_PASS env var"
      });
    }

    if (!sharedPassword || String(sharedPassword) !== String(expectedPassword)) {
      return sendJson(res, 401, {
        ok: false,
        error: "Unauthorized"
      });
    }

    const mailUser = process.env.MAIL_USER || "";
    const mailPass = process.env.MAIL_PASS || "";

    if (!mailUser || !mailPass) {
      return sendJson(res, 500, {
        ok: false,
        error: "Missing MAIL_USER/MAIL_PASS env vars"
      });
    }

    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    const batchName = String(body.batchName || "").trim() || null;
    const rows = Array.isArray(body.rows) ? body.rows : [];

    if (!rows.length) {
      return sendJson(res, 400, {
        ok: false,
        error: "No rows provided"
      });
    }

    const baseUrl = getBaseUrl(req);
    const authHeader =
      "Basic " + Buffer.from(`${mailUser}:${mailPass}`).toString("base64");

    const results = [];

    for (let i = 0; i < rows.length; i++) {
      const originalRow = rows[i] || {};
      const rowNumber = i + 1;
      const cleanRow = sanitizeRow(originalRow);
      const validation = validateRow(cleanRow);

      if (!validation.ok) {
        const result = {
          rowNumber,
          name: cleanRow.name || null,
          ok: false,
          error: `Missing required fields: ${validation.missing.join(", ")}`
        };

        results.push(result);

        await postToSheets(SHEETS_WEBHOOK_URL, {
          source: "Lifeline Bulk Print",
          batch_name: batchName,
          row_number: rowNumber,
          created_at_iso: new Date().toISOString(),

          customer_name: cleanRow.name || "",
          customer_phone: cleanRow.phone || "",
          from_address1: cleanRow.address1 || "",
          from_address2: cleanRow.address2 || "",
          from_city: cleanRow.city || "",
          from_state: cleanRow.state || "",
          from_zip: cleanRow.zip || "",

          device_type: cleanRow.deviceType || "",
          device_serial: cleanRow.deviceSerial || "",
          return_reason: cleanRow.returnReason || "",
          weight_oz: cleanRow.weightOz ?? null,

          tracking_number: "",
          lob_letter_id: "",
          lob_status: "",
          status: "Failed",
          error_message: result.error
        });

        continue;
      }

      try {
        const resp = await fetch(`${baseUrl}/api/mail-label`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": authHeader
          },
          body: JSON.stringify(cleanRow)
        });

        const data = await resp.json().catch(() => null);

        if (!resp.ok || !data?.ok) {
          const result = {
            rowNumber,
            name: cleanRow.name || null,
            ok: false,
            error: data?.error || `HTTP ${resp.status}`,
            details: data?.details || null
          };

          results.push(result);

          await postToSheets(SHEETS_WEBHOOK_URL, {
            source: "Lifeline Bulk Print",
            batch_name: batchName,
            row_number: rowNumber,
            created_at_iso: new Date().toISOString(),

            customer_name: cleanRow.name || "",
            customer_phone: cleanRow.phone || "",
            from_address1: cleanRow.address1 || "",
            from_address2: cleanRow.address2 || "",
            from_city: cleanRow.city || "",
            from_state: cleanRow.state || "",
            from_zip: cleanRow.zip || "",

            device_type: cleanRow.deviceType || "",
            device_serial: cleanRow.deviceSerial || "",
            return_reason: cleanRow.returnReason || "",
            weight_oz: cleanRow.weightOz ?? null,

            tracking_number: "",
            lob_letter_id: "",
            lob_status: "",
            status: "Failed",
            error_message: result.error
          });

          continue;
        }

        const result = {
          rowNumber,
          name: cleanRow.name || null,
          ok: true,
          lobLetterId: data.lobLetterId || null,
          lobStatus: data.lobStatus || null,
          uspsTrackingNumber: data.uspsTrackingNumber || null,
          weightOz: data.weightOz || cleanRow.weightOz || null
        };

        results.push(result);

        await postToSheets(SHEETS_WEBHOOK_URL, {
          source: "Lifeline Bulk Print",
          batch_name: batchName,
          row_number: rowNumber,
          created_at_iso: new Date().toISOString(),

          customer_name: cleanRow.name || "",
          customer_phone: cleanRow.phone || "",
          from_address1: cleanRow.address1 || "",
          from_address2: cleanRow.address2 || "",
          from_city: cleanRow.city || "",
          from_state: cleanRow.state || "",
          from_zip: cleanRow.zip || "",

          device_type: cleanRow.deviceType || "",
          device_serial: cleanRow.deviceSerial || "",
          return_reason: cleanRow.returnReason || "",
          weight_oz: result.weightOz ?? null,

          tracking_number: result.uspsTrackingNumber || "",
          lob_letter_id: result.lobLetterId || "",
          lob_status: result.lobStatus || "",
          status: "Mailed",
          error_message: ""
        });
      } catch (e) {
        const result = {
          rowNumber,
          name: cleanRow.name || null,
          ok: false,
          error: String(e)
        };

        results.push(result);

        await postToSheets(SHEETS_WEBHOOK_URL, {
          source: "Lifeline Bulk Print",
          batch_name: batchName,
          row_number: rowNumber,
          created_at_iso: new Date().toISOString(),

          customer_name: cleanRow.name || "",
          customer_phone: cleanRow.phone || "",
          from_address1: cleanRow.address1 || "",
          from_address2: cleanRow.address2 || "",
          from_city: cleanRow.city || "",
          from_state: cleanRow.state || "",
          from_zip: cleanRow.zip || "",

          device_type: cleanRow.deviceType || "",
          device_serial: cleanRow.deviceSerial || "",
          return_reason: cleanRow.returnReason || "",
          weight_oz: cleanRow.weightOz ?? null,

          tracking_number: "",
          lob_letter_id: "",
          lob_status: "",
          status: "Failed",
          error_message: result.error
        });
      }

      await sleep(150);
    }

    const successCount = results.filter((r) => r.ok).length;
    const failureCount = results.length - successCount;

    return sendJson(res, 200, {
      ok: true,
      batchName,
      totalRows: rows.length,
      successCount,
      failureCount,
      results
    });
  } catch (e) {
    return sendJson(res, 500, {
      ok: false,
      error: String(e)
    });
  }
}
