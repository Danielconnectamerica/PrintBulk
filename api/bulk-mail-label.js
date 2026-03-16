// /api/bulk-mail-label.js
// Bulk physical return label mailer
// - Accepts { batchName, rows: [...] }
// - Validates shared password via x-bulk-password
// - Internally calls /api/mail-label with MAIL_USER / MAIL_PASS Basic Auth
// - Processes rows one-by-one
// - Intentionally ignores email fields

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
        results.push({
          rowNumber,
          name: cleanRow.name || null,
          ok: false,
          error: `Missing required fields: ${validation.missing.join(", ")}`
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
          results.push({
            rowNumber,
            name: cleanRow.name || null,
            ok: false,
            error: data?.error || `HTTP ${resp.status}`,
            details: data?.details || null
          });
          continue;
        }

        results.push({
          rowNumber,
          name: cleanRow.name || null,
          ok: true,
          lobLetterId: data.lobLetterId || null,
          lobStatus: data.lobStatus || null,
          uspsTrackingNumber: data.uspsTrackingNumber || null,
          weightOz: data.weightOz || cleanRow.weightOz || null
        });
      } catch (e) {
        results.push({
          rowNumber,
          name: cleanRow.name || null,
          ok: false,
          error: String(e)
        });
      }

      // Small throttle to reduce API bursts
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
