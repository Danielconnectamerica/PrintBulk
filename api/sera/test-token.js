export default async function handler(req, res) {
  const env = process.env.SERA_ENV || "staging";
  const signinBase =
    env === "production"
      ? "https://signin.stampsendicia.com"
      : "https://signin.testing.stampsendicia.com";

  const tokenUrl = `${signinBase}/oauth/token`;

  try {
    const form = new URLSearchParams();
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", process.env.SERA_REFRESH_TOKEN);
    form.set("client_id", process.env.SERA_CLIENT_ID);
    form.set("client_secret", process.env.SERA_CLIENT_SECRET);

    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const data = await resp.json().catch(() => null);

    if (!resp.ok || !data) {
      return res.status(400).json({
        ok: false,
        error: "Failed to refresh access token",
        httpStatus: resp.status,
        data,
      });
    }

    // Don’t return the token itself — just confirm it worked.
    return res.status(200).json({
      ok: true,
      message: "Access token refresh worked",
      expires_in: data.expires_in,
      token_type: data.token_type,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
