// ============================================================
// GET /api/key
// ------------------------------------------------------------
// Returns the Gemini API key from Vercel's environment variables.
// This is the "plain key" approach: no ephemeral-token minting, no
// SDK dependency — just keeps the key out of your source code /
// GitHub repo and out of the browser's localStorage.
//
// Heads up: the browser still receives the real key and puts it in
// a WebSocket URL, so anyone with devtools open during a call can
// see it in the network tab. To limit the blast radius if that
// happens, restrict the key in Google AI Studio to your site's
// domain (API key settings → Website restrictions).
// ============================================================

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Missing GEMINI_API_KEY environment variable");
    return res.status(500).json({ error: "Server is not configured (missing API key)." });
  }

  return res.status(200).json({ apiKey });
};
