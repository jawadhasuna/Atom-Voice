// ============================================================
// GET /api/key
// ------------------------------------------------------------
// Returns the Gemini API key from Vercel's environment variables,
// but only to requests whose Origin header matches your own site.
// This is the "plain key" approach: no ephemeral-token minting, no
// SDK dependency — just keeps the key out of your source code /
// GitHub repo, and out of reach of anyone who just finds this URL.
//
// Heads up: a legitimate visitor to your own site who opens devtools
// can still see the key in the network tab after it's returned to
// them — this check stops opportunistic grabbing of the URL itself,
// not inspection by someone actually using your app.
// ============================================================

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Origin isn't reliably sent by every browser on a plain same-origin GET
// (Safari in particular often omits it). Referer is sent more consistently
// for this kind of request, so we check both and accept whichever is
// present and valid.
function extractOrigin(headerValue) {
  if (!headerValue) return null;
  try {
    const url = new URL(headerValue);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const requestOrigin = extractOrigin(req.headers.origin) || extractOrigin(req.headers.referer);

  if (allowedOrigins.length > 0 && !allowedOrigins.includes(requestOrigin)) {
    console.warn(`Blocked /api/key request from origin: ${requestOrigin || "(none)"}`);
    return res.status(403).json({ error: "Forbidden" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Missing GEMINI_API_KEY environment variable");
    return res.status(500).json({ error: "Server is not configured (missing API key)." });
  }

  return res.status(200).json({ apiKey });
};
