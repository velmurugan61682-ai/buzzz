import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";

// Load environment variables from server/.env if present
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = join(__dirname, "..", "server", ".env");
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

import { apiRouter } from "../server/src/routes/api.js";
import { connectDB } from "../server/src/data/db.js";

const app = express();

// Enable CORS for Vercel and local origins
app.use(
  cors({
    origin: (origin, callback) => callback(null, true),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-workspace-id", "Idempotency-Key", "x-gowhats-secret"],
  })
);

app.use(express.json({ limit: "10mb" }));

// Request logger
app.use((req, res, next) => {
  const ws = req.headers["x-workspace-id"] || "ws_default";
  console.log(`[Vercel Serverless] ${req.method} ${req.originalUrl} (ws: ${ws})`);
  next();
});

// Cache database connection across serverless invocations
let isDbInitialized = false;
const ensureDatabase = async () => {
  if (!isDbInitialized) {
    try {
      await connectDB();
      isDbInitialized = true;
    } catch (err) {
      console.warn("⚠️ [Vercel Serverless] DB connection fallback warning:", err.message);
    }
  }
};

app.use(async (req, res, next) => {
  await ensureDatabase();
  next();
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    mode: "vercel-serverless",
    timestamp: new Date().toISOString(),
  });
});

// Mount API routes
app.use("/api/v1", apiRouter);
app.use("/api", apiRouter);

// Clean JSON 404 handler for API routes
app.use((req, res) => {
  res.status(404).json({
    code: "not_found",
    message: `API route ${req.method} ${req.originalUrl} not found`,
  });
});

// Clean JSON error handler
app.use((err, req, res, _next) => {
  console.error("Vercel Serverless Error:", err);
  res.status(err.status || 500).json({
    code: err.code || "internal_server_error",
    message: err.message || "An unexpected server error occurred",
  });
});

export default app;
