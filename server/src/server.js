import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { apiRouter } from "./routes/api.js";
import { connectDB } from "./data/db.js";

dotenv.config();

// Step 1: Startup Environment Validation (Fail fast if essential keys are missing)
const hasApiKey = Boolean(process.env.CHANNELBOT_API_KEY || process.env.GOWHATS_API_KEY);
const hasBaseUrl = Boolean(process.env.CHANNELBOT_BASE_URL || process.env.GOWHATS_BASE_URL);
const hasMongoUri = Boolean(process.env.MONGODB_URI);
const hasLinkedInKeys = Boolean(
  process.env.LINKEDIN_CLIENT_ID &&
  process.env.LINKEDIN_CLIENT_SECRET &&
  process.env.LINKEDIN_REDIRECT_URI
);

if (!hasMongoUri || !hasApiKey || !hasBaseUrl || !hasLinkedInKeys) {
  const missing = [];
  if (!hasMongoUri) missing.push("MONGODB_URI");
  if (!hasApiKey) missing.push("CHANNELBOT_API_KEY / GOWHATS_API_KEY");
  if (!hasBaseUrl) missing.push("CHANNELBOT_BASE_URL / GOWHATS_BASE_URL");
  if (!hasLinkedInKeys) missing.push("LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET / LINKEDIN_REDIRECT_URI");

  console.error(`🚨 FATAL STARTUP ERROR: Missing required environment variables: ${missing.join(", ")}`);
  console.error(`Please configure these environment keys in server/.env before launching.`);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 5000;

// CORS configuration
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow local development ports (Vite 5173, etc.) and missing origin (like curl/Postman)
      if (!origin || origin.includes("localhost") || origin.includes("127.0.0.1")) {
        return callback(null, true);
      }
      callback(null, true);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-workspace-id", "Idempotency-Key", "x-gowhats-secret"],
  })
);

// Body parser (JSON)
app.use(express.json());

// Request logger middleware
app.use((req, res, next) => {
  const ws = req.headers["x-workspace-id"] || "ws_default";
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} (ws: ${ws})`);
  next();
});

// Mount API router on both /api/v1 and /api
app.use("/api/v1", apiRouter);
app.use("/api", apiRouter);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    code: "not_found",
    message: `Endpoint ${req.method} ${req.originalUrl} not found`,
    request_id: `req_${Date.now()}`,
  });
});

// Global Error Handler Envelope
app.use((err, req, res, _next) => {
  console.error("Unhandled Server Error:", err);
  const status = err.status || 500;
  res.status(status).json({
    code: err.code || "internal_server_error",
    message: err.message || "An unexpected server error occurred",
    request_id: `req_${Date.now()}`,
    fields: err.fields || null,
  });
});

// Initialize DB and Start Server
const startServer = async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 BUZZZ Express Server running on http://localhost:${PORT}`);
    console.log(`📡 API Base URL: http://localhost:${PORT}/api/v1`);
    console.log(`=======================================================`);
  });
};

startServer();
