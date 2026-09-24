import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const key = (process.env.INSTAXBOT_API_KEY || "").trim();
const baseUrl = (process.env.INSTAXBOT_BASE_URL || "https://app.instaxbot.com").replace(/\/$/, "");

const endpoints = [
  { path: "/api/external/v2/chats/transfer", method: "POST", body: { senderId: "test_user_1" } },
  { path: "/api/external/v2/templates", method: "GET" },
  { path: "/api/external/v2/inventory", method: "GET" },
  { path: "/api/external/v2/broadcasts", method: "GET" },
  { path: "/api/external/v2/webhooks", method: "GET" },
  { path: "/api/external/v2/chats", method: "POST", body: { recipientId: "test", message: "hi" } },
  { path: "/api/external/v2/chat", method: "GET" },
  { path: "/api/external/v2/chat/messages", method: "GET" },
  { path: "/api/external/v2/livechat", method: "GET" },
  { path: "/api/external/v2/live-chat", method: "GET" },
  { path: "/api/external/v2/orders", method: "GET" },
];

for (const ep of endpoints) {
  const url = `${baseUrl}${ep.path}`;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    const options = {
      method: ep.method || "GET",
      headers: {
        "X-API-KEY": key,
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      signal: controller.signal
    };
    if (ep.body) {
      options.body = JSON.stringify(ep.body);
    }
    const res = await fetch(url, options);
    clearTimeout(t);
    const text = await res.text();
    console.log(`[${res.status}] (${ep.method} ${ep.path}) -> ${text.slice(0, 160).replace(/\n/g, " ")}`);
  } catch (err) {
    console.log(`[FAIL] (${ep.method} ${ep.path}) -> ${err.message}`);
  }
}
