import { GoogleGenAI } from "@google/genai";
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
scopes: "https://www.googleapis.com/auth/cloud-platform"
});
const authClient = await auth.getClient();
const client = new GoogleGenAI({
authClient,
httpOptions: { apiVersion: "v1alpha" }
});
const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
const newSessionExpireTime = new Date(Date.now() + 2 * 60 * 1000).toISOString();
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
}
