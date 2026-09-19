import express from "express";
import cors from "cors";
import dotenv from "dotenv";


import { apiRouter, broadcastSseEvent } from "./routes/api.js";
import { connectDB } from "./data/db.js";
import { startGmailMessagesAutoSyncScheduler } from "./services/gmailAuth.js";
import { startGoWhatsAutoSyncScheduler } from "./services/gowhats.js";
import { startInstaxBotAutoSyncScheduler } from "./services/instaxbot.js";
import { startChannelBotAutoSyncScheduler } from "./services/channelbot.js";

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
const hasGoogleKeys = Boolean(
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET &&
  process.env.GOOGLE_REDIRECT_URI
);

if (!hasMongoUri || !hasApiKey || !hasBaseUrl || !hasLinkedInKeys || !hasGoogleKeys) {
  const missing = [];
  if (!hasMongoUri) missing.push("MONGODB_URI");
  if (!hasApiKey) missing.push("CHANNELBOT_API_KEY / GOWHATS_API_KEY");
  if (!hasBaseUrl) missing.push("CHANNELBOT_BASE_URL / GOWHATS_BASE_URL");
  if (!hasLinkedInKeys) missing.push("LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET / LINKEDIN_REDIRECT_URI");
  if (!hasGoogleKeys) missing.push("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI");

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
    allowedHeaders: ["Content-Type", "Authorization", "x-workspace-id", "x-session-token", "Idempotency-Key", "x-gowhats-secret"],
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

process.on("unhandledRejection", (reason, _promise) => {
  console.warn("⚠️ Handled global unhandledRejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("⚠️ Handled global uncaughtException:", err.message);
});

// Initialize DB and Start Server
const startServer = async () => {
  await connectDB();

  // Start background auto-sync schedulers for all connected channels (polling every 30-60 seconds)
  startGmailMessagesAutoSyncScheduler(broadcastSseEvent, 30000);
  startGoWhatsAutoSyncScheduler(broadcastSseEvent, 10000);
  startInstaxBotAutoSyncScheduler(broadcastSseEvent, 45000);
  const channelBotSyncIntervalMs = parseInt(process.env.CHANNELBOT_SYNC_INTERVAL_MS, 10) || 120000; // 2 minutes auto-sync
  startChannelBotAutoSyncScheduler(broadcastSseEvent, channelBotSyncIntervalMs);

  const server = app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 BUZZZ Express Server running on http://localhost:${PORT}`);
    console.log(`📡 API Base URL: http://localhost:${PORT}/api/v1`);
    console.log(`=======================================================`);
  });

  const gracefulShutdown = (signal) => {
    console.log(`\n🛑 Received ${signal}. Closing HTTP server gracefully...`);
    server.close(() => {
      console.log(`✅ Server port ${PORT} released.`);
      if (signal === "SIGUSR2") {
        process.kill(process.pid, "SIGUSR2");
      } else {
        process.exit(0);
      }
    });
  };

  process.once("SIGUSR2", () => gracefulShutdown("SIGUSR2"));
  process.once("SIGINT", () => gracefulShutdown("SIGINT"));
  process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));

  let retries = 0;
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      if (retries < 4) {
        retries++;
        console.warn(`⚠️ Port ${PORT} busy, retrying bind in 1.5s (attempt ${retries}/4)...`);
        setTimeout(() => {
          try { server.close(); } catch (_) {}
          server.listen(PORT);
        }, 1500);
        return;
      }
      console.error(`\n🚨 PORT COLLISION ERROR (EADDRINUSE):`);
      console.error(`Port ${PORT} is already in use by another running process!`);
      console.error(`To resolve this port conflict:`);
      console.error(`  1. Kill the process running on port ${PORT}: npx kill-port ${PORT} (or taskkill /F /PID <pid> on Windows)`);
      console.error(`  2. Or update the PORT variable in server/.env (e.g., PORT=5001)`);
      process.exit(1);
    } else {
      console.error("❌ Unexpected server startup error:", err);
      process.exit(1);
    }
  });
};

startServer();

