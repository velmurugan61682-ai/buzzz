import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import linkedinRoutes from "./routes/linkedin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load server/.env then fallback to root .env
function loadEnv() {
  const serverEnvPath = path.resolve(__dirname, "../.env");
  const rootEnvPath = path.resolve(__dirname, "../../.env");
  const envPath = fs.existsSync(serverEnvPath) ? serverEnvPath : fs.existsSync(rootEnvPath) ? rootEnvPath : null;
  if (envPath) {
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}
loadEnv();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "buzz-server", uptime: process.uptime() });
});

// Buzz endpoint
app.get("/api/buzz", (req, res) => {
  res.json({ message: "Buzz API active" });
});

// Mount LinkedIn routes under /api/linkedin
app.use("/api/linkedin", linkedinRoutes);

app.listen(PORT, () => {
  console.log(`🚀 Buzz Server running on http://localhost:${PORT}`);
  console.log(`🔗 LinkedIn Auth:   http://localhost:${PORT}/api/linkedin/auth`);
  console.log(`🔗 LinkedIn Post:   http://localhost:${PORT}/api/linkedin/post`);
});

export default app;
