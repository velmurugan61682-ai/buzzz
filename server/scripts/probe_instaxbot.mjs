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
  "/api/external/v2/orders",
  "/api/external/v2/orders?page=1&limit=5",
  "/api/external/v2/data?resource=orders",
  "/api/external/v2/clients",
  "/api/external/v2/comments",
  "/api/external/v2/templates",
  "/api/external/v2/broadcasts",
  "/api/external/v2/messages",
  "/api/v1/external/messages",
  "/api/v1/messages",
  "/api/v1/orders",
  "/api/messages",
  "/api/orders",
  "/api/comments",
  "/api/v2/orders",
  "/api/v2/comments",
  "/api/external/orders"
];

for (const ep of endpoints) {
  const url = `${baseUrl}${ep}`;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3500);
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
    console.log(`[${res.status}] (${ct.split(";")[0]}) ${ep} -> ${text.slice(0, 100).replace(/\n/g, " ")}`);
  } catch (err) {
    console.log(`[ERROR/TIMEOUT] ${ep} -> ${err.message}`);
  }
}
