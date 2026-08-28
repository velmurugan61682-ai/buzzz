import { Router } from "express";
import { getMongoDBStatus } from "../lib/mongodb.js";

export const health = Router();

health.get("/", (_req, res) => res.json({ status: "ok", mongodb: getMongoDBStatus() }));

health.get("/mongodb", (_req, res) => {
  res.json({ mongodb: getMongoDBStatus() });
});

health.get("/ready", async (_req, res) => {
  const checks = {
    database: "ok",
    mongodb: getMongoDBStatus(),
  };
  res.json({ ready: true, checks });
});

health.get("/version", (_req, res) =>
  res.json({ commit: process.env.GIT_SHA || "dev", version: process.env.npm_package_version || "1.0.0" })
);
