// api/get-token.js
//
// This runs on Vercel's server, never in the browser.
// It holds the REAL Gemini API key (from an environment variable) and uses it
// to mint a short-lived, single-use "ephemeral token" that the browser can
// safely use instead. Even if someone extracts the token from the browser,
// it expires quickly and is locked to this specific model/config.

import { GoogleGenAI } from "@google/genai";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server misconfigured: GEMINI_API_KEY not set" });
  }

  try {
    const client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } });

    const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min to use
    const newSessionExpireTime = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // 2 min to start

    const token = await client.authTokens.create({
      config: {
        uses: 1,
        expireTime,
        newSessionExpireTime,
        liveConnectConstraints: {
          model: "gemini-3.1-flash-live-preview",
          config: {
            responseModalities: ["AUDIO"],
          },
        },
        httpOptions: { apiVersion: "v1alpha" },
      },
    });

    return res.status(200).json({ token: token.name });
  } catch (error) {
    console.error("Token creation failed:", error);
    return res.status(500).json({ error: "Failed to create ephemeral token" });
  }
}
