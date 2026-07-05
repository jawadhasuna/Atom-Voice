

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const origin = req.headers.origin;

  if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
    console.warn(`Blocked /api/key request from origin: ${origin || "(none)"}`);
    return res.status(403).json({ error: "Forbidden" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Missing GEMINI_API_KEY environment variable");
    return res.status(500).json({ error: "Server is not configured (missing API key)." });
  }

  return res.status(200).json({ apiKey });
};
