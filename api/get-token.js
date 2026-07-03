import { GoogleAuth } from "google-auth-library";
export default async function handler(req, res) {
if (req.method !== "GET") {
return res.status(405).json({ error: "Method not allowed" });
}
const credentialsData = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!credentialsData) {
return res.status(500).json({ error: "Service account JSON not set" });
}
const credentials = JSON.parse(credentialsData);
const auth = new GoogleAuth({
credentials,
scopes: ["https://www.googleapis.com/auth/cloud-platform"]
});
const client = await auth.getClient();
const accessToken = await client.getAccessToken();
const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
const newSessionExpireTime = new Date(Date.now() + 2 * 60 * 1000).toISOString();
const response = await fetch("https://generativelanguage.googleapis.com/v1alpha/authTokens", {
method: "POST",
headers: {
"Authorization": `Bearer ${accessToken.token}`,
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
const data = await response.json();
if (!response.ok) {
return res.status(response.status).json({ error: data.error?.message || "Failed to create token" });
}
return res.status(200).json({ token: data.name });
}
