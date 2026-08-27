import { Router } from "express";
export const health = Router();

health.get("/", (_req, res) => res.json({ status: "ok" }));
health.get("/ready", async (_req, res) => {
  // Readiness must actually check dependencies; the load balancer uses this, not /health.
  const checks = { database: "unconfigured", redis: "unconfigured", queue: "unconfigured" };
  const ready = Object.values(checks).every((v) => v === "ok");
  res.status(ready ? 200 : 503).json({ ready, checks });
});
health.get("/version", (_req, res) =>
  res.json({ commit: process.env.GIT_SHA || "dev", version: process.env.npm_package_version || "1.0.0" })
);
