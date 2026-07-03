export default async function handler(req, res) {
if (req.method !== "GET") {
return res.status(405).json({ error: "Method not allowed" });
}
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
return res.status(500).json({ error: "API key not set" });
}
const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
const newSessionExpireTime = new Date(Date.now() + 2 * 60 * 1000).toISOString();
const response = await fetch("https://generativelanguage.googleapis.com/v1alpha/authTokens", {
method: "POST",
headers: {
"x-goog-api-key": apiKey,
"Content-Type": "application/json"
},
body: JSON.stringify({
config: {
uses: 1,
expireTime,
newSessionExpireTime,
liveConnectConstraints: {
model: "gemini-3.1-flash-live-preview",
config: {
responseModalities: ["AUDIO"]
}
}
}
})
});
const isJson = response.headers.get("content-type")?.includes("application/json");
const data = isJson ? await response.json() : await response.text();
if (!response.ok) {
return res.status(response.status).json({ error: isJson ? data.error?.message : "Failed to create token" });
}
return res.status(200).json({ token: data.name });
}
