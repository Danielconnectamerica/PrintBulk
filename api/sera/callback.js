/**
 * Endicia / Stamps.com SERA OAuth callback (Production)
 * Uses HTTP Basic Auth for client authentication (fixes 401 Unauthorized)
 */

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "text/plain");

  try {
    const SIGNIN_BASE = process.env.SERA_SIGNIN_BASE; // https://signin.stampsendicia.com
    const CLIENT_ID = process.env.SERA_CLIENT_ID;
    const CLIENT_SECRET = process.env.SERA_CLIENT_SECRET;
    const REDIRECT_URI = process.env.SERA_REDIRECT_URI; // https://causps.vercel.app/api/sera/callback

    if (!SIGNIN_BASE || !CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
      res.statusCode = 500;
      return res.end(
        "❌ Missing env vars. Need:\n" +
        "- SERA_SIGNIN_BASE\n- SERA_CLIENT_ID\n- SERA_CLIENT_SECRET\n- SERA_REDIRECT_URI\n"
      );
    }

    const code = req.query.code;
    if (!code) {
      res.statusCode = 400;
      return res.end("❌ Missing ?code= in callback URL.\n");
    }

    const tokenUrl = SIGNIN_BASE.replace(/\/$/, "") + "/oauth/token";

    // IMPORTANT: Use Basic Auth header (client_id:client_secret)
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

    // Form body should NOT include client_secret for Basic-auth style servers
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: REDIRECT_URI
    });

    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${basic}`
      },
      body
    });

    const raw = await resp.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    if (!resp.ok) {
      res.statusCode = resp.status;
      return res.end(
        `❌ Token exchange failed\n\nHTTP Status: ${resp.status}\n\n` +
        JSON.stringify(data, null, 2) +
        `\n\nDebug:\n` +
        `TOKEN_URL=${tokenUrl}\n` +
        `REDIRECT_URI=${REDIRECT_URI}\n` +
        `CLIENT_ID_LAST4=${String(CLIENT_ID).slice(-4)}\n`
      );
    }

    if (!data.refresh_token) {
      res.statusCode = 500;
      return res.end(
        "❌ Success but no refresh_token returned:\n\n" +
        JSON.stringify(data, null, 2)
      );
    }

    res.statusCode = 200;
    return res.end(
      "✅ SUCCESS\n\nCopy this refresh_token into Vercel as SERA_REFRESH_TOKEN:\n\n" +
      data.refresh_token + "\n"
    );

  } catch (e) {
    res.statusCode = 500;
    return res.end("❌ Server error: " + String(e) + "\n");
  }
};
