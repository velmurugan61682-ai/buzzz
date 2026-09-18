import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const key = (process.env.INSTAXBOT_API_KEY || "").trim();
const baseUrl = (process.env.INSTAXBOT_BASE_URL || "https://app.instaxbot.com").replace(/\/$/, "");

console.log("Base URL:", baseUrl);
console.log("Key length:", key.length, "Prefix:", key.slice(0, 5));

const endpoints = [
  "/api/external/v2/me",
  "/api/external/v2/account",
  "/api/external/v2/profile",
  "/api/external/v2/keys",
  "/api/external/v2/webhooks",
  "/api/external/v2/threads",
  "/api/external/v2/conversations",
  "/api/external/v2/livechat",
  "/api/external/v2/instagram",
  "/api/external/v2/bot",
];

for (const ep of endpoints) {
  const url = `${baseUrl}${ep}`;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "X-API-KEY": key,
        "Authorization": `Bearer ${key}`,
        "Accept": "application/json",
      },
      signal: controller.signal
    });
    clearTimeout(t);
    const ct = res.headers.get("content-type") || "";
    const text = await res.text();
    console.log(`[${res.status}] (${ct.split(";")[0]}) ${ep} -> ${text.slice(0, 160).replace(/\n/g, " ")}`);
    if (ep.includes("orders") && res.status === 200) {
      try {
        const json = JSON.parse(text);
        const sample = (json.orders && json.orders[0]) || (json.data && json.data[0]);
        if (sample) {
          console.log("SAMPLE ORDER FIELDS:", Object.keys(sample));
          console.log("SAMPLE ORDER RAW:", JSON.stringify(sample, null, 2).slice(0, 500));
        }
      } catch (e) {}
    }
  } catch (err) {
    console.log(`[TIMEOUT/FAIL] ${ep} -> ${err.message}`);
  }
}
