// /api/mail-label.js
// Creates an Endicia (SERA) return label via /api/create-label,
// builds a combined PDF (instructions + label placed in bottom half),
// and mails it via Lob as a Letter using address_placement=insert_blank_page.
// Physical-mail version: intentionally does NOT pass or capture email fields.

import { PDFDocument } from "pdf-lib";
import fs from "fs";
import path from "path";

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

function unauthorized(res) {
  res.statusCode = 401;
  res.setHeader("WWW-Authenticate", 'Basic realm="Return Label Mailer"');
  res.end("Unauthorized");
}

function parseBasicAuth(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header || !header.toString().startsWith("Basic ")) return null;

  try {
    const decoded = Buffer.from(
      header.toString().replace("Basic ", ""),
      "base64"
    ).toString("utf8");

    const idx = decoded.indexOf(":");
    if (idx === -1) return null;

    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
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

function buildCreateLabelPayload(body) {
  const payload = {
    name: requireField(body, "name"),
    address1: requireField(body, "address1"),
    address2: requireField(body, "address2") || "",
    city: requireField(body, "city"),
    state: requireField(body, "state"),
    zip: requireField(body, "zip"),
    phone: requireField(body, "phone"),
    deviceType: requireField(body, "deviceType"),
    deviceSerial: requireField(body, "deviceSerial") || "",
    returnReason: requireField(body, "returnReason") || "",
    weightOz: normalizeWeightOz(body),
  };

  // Intentionally DO NOT pass:
  // email, customerEmail, agentEmail, or any other email-like field

  return payload;
}

/**
 * Build PDF:
 * - Includes power-off-instructions.pdf (all pages) if present
 * - Appends a letter-sized page with the 4x6 label printed in the BOTTOM HALF
 *   so typical folds won't run through the barcode.
 */
async function buildInstructionsPlusLabelPdf({ labelBase64 }) {
  const labelBytes = Buffer.from(labelBase64, "base64");
  const out = await PDFDocument.create();

  // Add instructions PDF if exists
  const instructionsPath = path.join(process.cwd(), "power-off-instructions.pdf");
  if (fs.existsSync(instructionsPath)) {
    const instrBytes = fs.readFileSync(instructionsPath);
    const instrPdf = await PDFDocument.load(instrBytes);
    const pages = await out.copyPages(instrPdf, instrPdf.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }

  // Add letter page
  const LETTER_W = 612; // 8.5" * 72
  const LETTER_H = 792; // 11"  * 72
  const page = out.addPage([LETTER_W, LETTER_H]);

  // Embed label PDF page 0
  const [embeddedLabel] = await out.embedPdf(labelBytes, [0]);

  // True 4x6 target size
  const targetW = 288;
  const targetH = 432;

  let scale = Math.min(targetW / embeddedLabel.width, targetH / embeddedLabel.height);
  let drawW = embeddedLabel.width * scale;
  let drawH = embeddedLabel.height * scale;

  const marginBottom = 24;
  const safeTop = LETTER_H / 2 - 18;
  const maxAllowedH = safeTop - marginBottom;

  if (drawH > maxAllowedH) {
    const extraScale = maxAllowedH / drawH;
    scale = scale * extraScale;
    drawW = embeddedLabel.width * scale;
    drawH = embeddedLabel.height * scale;
  }

  const x = (LETTER_W - drawW) / 2;
  const y = marginBottom;

  page.drawPage(embeddedLabel, { x, y, xScale: scale, yScale: scale });

  return Buffer.from(await out.save());
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
    }

    // Basic Auth
    const creds = parseBasicAuth(req);
    const expectedUser = process.env.MAIL_USER || "";
    const expectedPass = process.env.MAIL_PASS || "";

    if (!expectedUser || !expectedPass) {
      return sendJson(res, 500, { ok: false, error: "Missing MAIL_USER/MAIL_PASS env vars" });
    }

    if (!creds || creds.user !== expectedUser || creds.pass !== expectedPass) {
      return unauthorized(res);
    }

    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    if (!process.env.LOB_API_KEY) {
      return sendJson(res, 500, { ok: false, error: "Missing LOB_API_KEY env var" });
    }

    // Required fields
    const name = requireField(body, "name");
    const address1 = requireField(body, "address1");
    const address2 = requireField(body, "address2") || "";
    const city = requireField(body, "city");
    const state = requireField(body, "state");
    const zip = requireField(body, "zip");
    const phone = requireField(body, "phone");
    const deviceType = requireField(body, "deviceType");

    const missing = [];
    if (!name) missing.push("name");
    if (!address1) missing.push("address1");
    if (!city) missing.push("city");
    if (!state) missing.push("state");
    if (!zip) missing.push("zip");
    if (!phone) missing.push("phone");
    if (!deviceType) missing.push("deviceType");

    if (missing.length) {
      return sendJson(res, 400, {
        ok: false,
        error: `Missing required fields: ${missing.join(", ")}`
      });
    }

    // 1) Generate USPS label using ONLY whitelisted physical-mail fields
    const baseUrl = getBaseUrl(req);
    const createLabelPayload = buildCreateLabelPayload(body);

    const labelResp = await fetch(`${baseUrl}/api/create-label`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createLabelPayload),
    });

    const labelJson = await labelResp.json().catch(() => null);

    if (!labelResp.ok || !labelJson?.labelData) {
      return sendJson(res, 400, {
        ok: false,
        error: "Label creation failed",
        httpStatus: labelResp.status,
        details: labelJson,
      });
    }

    const trackingNumber = labelJson.trackingNumber || labelJson.tracking_number || "";
    const weightOz = normalizeWeightOz(createLabelPayload);

    // 2) Build combined PDF
    const combinedPdfBuffer = await buildInstructionsPlusLabelPdf({
      labelBase64: labelJson.labelData,
    });

    // 3) Send to Lob
    const form = new FormData();

    // recipient
    form.set("to[name]", name);
    form.set("to[address_line1]", address1);
    if (address2) form.set("to[address_line2]", address2);
    form.set("to[address_city]", city);
    form.set("to[address_state]", state);
    form.set("to[address_zip]", zip);

    // sender
    form.set("from[name]", process.env.LOB_FROM_NAME || "Lifeline");
    form.set("from[address_line1]", process.env.LOB_FROM_ADDRESS1 || "3 Bala Plaza West");
    form.set("from[address_city]", process.env.LOB_FROM_CITY || "Bala Cynwyd");
    form.set("from[address_state]", process.env.LOB_FROM_STATE || "PA");
    form.set("from[address_zip]", process.env.LOB_FROM_ZIP || "19004");

    // letter options
    form.set("color", "true");
    form.set("use_type", "operational");
    form.set("address_placement", "insert_blank_page");

    // attach file
    form.set(
      "file",
      new Blob([combinedPdfBuffer], { type: "application/pdf" }),
      "return-label-and-instructions.pdf"
    );

    const auth = Buffer.from(`${process.env.LOB_API_KEY}:`).toString("base64");
    const lobResp = await fetch("https://api.lob.com/v1/letters", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
      body: form,
    });

    const lobJson = await lobResp.json().catch(() => null);

    if (!lobResp.ok || !lobJson?.id) {
      return sendJson(res, 400, {
        ok: false,
        error: "Lob letter creation failed",
        httpStatus: lobResp.status,
        details: lobJson,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      uspsTrackingNumber: trackingNumber || null,
      weightOz: weightOz || null,
      lobLetterId: lobJson.id,
      lobStatus: lobJson.status || null,
    });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e) });
  }
}
