export default async function handler(req, res) {
  const env = process.env.SERA_ENV || "staging";
  const signinBase =
    env === "production"
      ? "https://signin.stampsendicia.com"
      : "https://signin.testing.stampsendicia.com";

  const clientId = process.env.SERA_CLIENT_ID;
  const redirectUri = process.env.SERA_REDIRECT_URI;

  const url =
    `${signinBase}/authorize` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent("offline_access")}`;

  res.writeHead(302, { Location: url });
  res.end();
}
