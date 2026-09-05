import fs from "fs";
import path from "path";
import net from "net";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "../.env");

console.log("=======================================================");
console.log("🔍 BUZZZ Platform Startup Check Script");
console.log("=======================================================");

// 1. Check .env file existence
if (!fs.existsSync(envPath)) {
  console.error("❌ CRITICAL ERROR: .env file missing in server directory!");
  console.error(`Expected filepath: ${envPath}`);
  console.error("Please create server/.env and fill in required environment keys.");
  process.exit(1);
}

dotenv.config({ path: envPath });

// 2. Verify all required environment variables
const requiredKeys = [
  "PORT",
  "MONGODB_URI",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
];

const missingKeys = [];
for (const key of requiredKeys) {
  if (!process.env[key] || !process.env[key].trim()) {
    missingKeys.push(key);
  }
}

if (missingKeys.length > 0) {
  console.error(`❌ CONFIGURATION ERROR: Missing required keys in .env:`);
  missingKeys.forEach((k) => console.error(`   - ${k}`));
  process.exit(1);
}
console.log("✅ All required environment variables present in .env file.");

// 3. Verify GOOGLE_REDIRECT_URI formatting & Google Cloud Console alignment
const redirectUri = process.env.GOOGLE_REDIRECT_URI.trim();
if (!redirectUri.startsWith("http://") && !redirectUri.startsWith("https://")) {
  console.error(`❌ INVALID REDIRECT URI: GOOGLE_REDIRECT_URI must start with http:// or https://`);
  console.error(`Current value: "${redirectUri}"`);
  process.exit(1);
}

if (!redirectUri.includes("/api/google/callback") && !redirectUri.includes("/api/v1/google/callback")) {
  console.warn(`⚠️ WARNING: GOOGLE_REDIRECT_URI does not contain standard callback path '/api/google/callback'.`);
  console.warn(`Current value: "${redirectUri}"`);
} else {
  console.log(`✅ GOOGLE_REDIRECT_URI validated: ${redirectUri}`);
}

// 4. Check Frontend / Backend port conflicts
const backendPort = parseInt(process.env.PORT || "5000", 10);
const commonFrontendPorts = [3000, 5173, 5174];

if (commonFrontendPorts.includes(backendPort)) {
  console.warn(`⚠️ PORT CONFLICT WARNING: Backend PORT (${backendPort}) matches standard frontend port (${commonFrontendPorts.join("/")}).`);
  console.warn(`Ensure frontend and backend run on different ports.`);
} else {
  console.log(`✅ Port separation check passed (Backend: ${backendPort}, Frontend: Vite 5173).`);
}

// 5. Test Backend Port Availability (Is Port Free?)
function checkPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

const isFree = await checkPortFree(backendPort);
if (!isFree) {
  console.error(`❌ PORT IN USE (EADDRINUSE): Backend port ${backendPort} is currently occupied by another running process.`);
  console.error(`Suggestions to resolve:`);
  console.error(` 1. Kill process on port ${backendPort}: npx kill-port ${backendPort} (or taskkill /F /PID <pid> on Windows)`);
  console.error(` 2. Or change PORT variable in server/.env (e.g., PORT=${backendPort + 1})`);
  process.exit(1);
}

console.log(`✅ Backend port ${backendPort} is free and ready.`);
console.log("=======================================================");
console.log("🎉 ALL STARTUP CHECKS PASSED SUCCESSFULLY!");
console.log("=======================================================");
process.exit(0);
