import { Router } from "express";
import { getMongoDBStatus } from "../lib/mongodb.js";

export const health = Router();

// Liveness Endpoint (Load balancer ping)
health.get("/", (_req, res) => res.json({ status: "ok", mongodb: getMongoDBStatus() }));

// MongoDB Specific Status Endpoint
health.get("/mongodb", (_req, res) => {
  res.json({ mongodb: getMongoDBStatus() });
});

// Comprehensive Readiness Check for Load Balancer Traffic Routing
health.get("/readiness", async (req, res) => {
  const mongoStatus = getMongoDBStatus();
  let dbStatus = "ok";

  if (req.db && typeof req.db.ping === "function") {
    try {
      await req.db.ping();
    } catch {
      dbStatus = "unreachable";
    }
  }

  const isReady = dbStatus === "ok";
  const checks = {
    postgres: dbStatus,
    mongodb: mongoStatus,
    redis: process.env.REDIS_URL ? "configured" : "offline_mode",
  };

  res.status(isReady ? 200 : 530).json({
    ready: isReady,
    status: isReady ? "ready" : "degraded",
    checks,
    timestamp: new Date().toISOString(),
  });
});

health.get("/ready", (req, res) => res.redirect(301, "/health/readiness"));

// Service Version & Commit Hash Endpoint
health.get("/version", (_req, res) =>
  res.json({
    service: "buzzz-api",
    commit: process.env.GIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || "dev",
    version: process.env.npm_package_version || "1.0.0",
  })
);
