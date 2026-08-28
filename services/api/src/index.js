/**
 * BUZZZ API — service entry point.
 *
 * STATUS: skeleton. The middleware below is real and is the part that must never
 * be skipped; the domain routes are stubs that return 501 until each is ported.
 * The porting work is mechanical: the business logic already exists as pure
 * functions in apps/web/src/App.jsx and moves here unchanged.
 */
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { requestId } from "./middleware/request-id.js";
import { authenticate } from "./middleware/authenticate.js";
import { tenantScope } from "./middleware/tenant-scope.js";
import { errorHandler } from "./middleware/error-handler.js";
import cookieParser from "cookie-parser";
import cors from "cors";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import pg from "pg";
import { health } from "./routes/health.js";
import { createDb } from "./lib/db.js";
import { authRoutes } from "./routes/auth.js";
import { googleRoutes, googleErrorHandler } from "./routes/google.js";
import { adminRoutes } from "./routes/admin.js";
import { crmRoutes } from "./routes/crm.js";
import { inboxRoutes } from "./routes/inbox.js";
import { schedulingRoutes } from "./routes/scheduling.js";
import { agentRoutes } from "./routes/agents.js";
import { workflowRoutes } from "./routes/workflows.js";
import { billingRoutes } from "./routes/billing.js";
import { integrationRoutes } from "./routes/integrations.js";

import { env } from "./config/env.js";
import { connectMongoDB } from "./lib/mongodb.js";

// Initialize MongoDB connection if MONGODB_URI is configured
if (env.MONGODB_URI) {
  connectMongoDB(env.MONGODB_URI);
}

/* One pool for the process. Every query goes through the data layer, which is
   where workspace isolation is enforced. */
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.PG_POOL_MAX,
  idleTimeoutMillis: 30000,
});
const db = createDb(pool);

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

/* CORS: an allow list, not a wildcard. Credentials are sent with every request,
   and "*" with credentials would let any site on the internet call this API as
   a signed in user. */
const ORIGINS = env.origins;
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);            // same origin and server to server
    return ORIGINS.includes(origin) ? cb(null, true)
      : cb(Object.assign(new Error("Origin not allowed"), { status: 403 }));
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  maxAge: 600,
}));

/* Rate limits. The tight one is on the endpoints an attacker hammers:
   credential stuffing against login, and reset floods against an inbox. */
const limiter = (windowMs, max, message) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false,
  message: { code: "rate_limited", message },
  /* Key on the address plus the account, so one attacker cannot lock out every
     user by guessing against a single address. ipKeyGenerator normalises IPv6
     into its /64 prefix: keying on the raw address lets an attacker with a v6
     allocation rotate through billions of addresses and never hit the limit. */
  keyGenerator: (req, res) => `${ipKeyGenerator(req, res)}|${(req.body && req.body.email) || ""}`,
});
const authLimiter = limiter(15 * 60 * 1000, 20, "Too many attempts. Try again in a few minutes.");
const resetLimiter = limiter(60 * 60 * 1000, 5, "Too many reset requests. Try again later.");
const apiLimiter = limiter(60 * 1000, 300, "Too many requests. Slow down.");
const adminLimiter = limiter(15 * 60 * 1000, 30, "Too many attempts.");

app.use("/api/v1/auth/login", authLimiter);
app.use("/api/v1/auth/signup", authLimiter);
app.use("/api/v1/auth/reset", resetLimiter);
app.use("/api/v1/admin/login", adminLimiter);
app.use("/api/v1", apiLimiter);
app.use(requestId);
app.use(pinoHttp({ redact: ["req.headers.authorization", "req.headers.cookie"] }));

// health checks are public; everything else is not
app.use("/health", health);

// Root route — public, no auth. Confirms the API is reachable (e.g. after a Vercel deploy).
app.get("/", (_req, res) =>
  res.json({
    status: "ok",
    message: "BUZZZ API is running",
    docs: "https://docs.buzzzbuzzz.com/api",
    version: process.env.npm_package_version || "1.0.0",
  })
);
app.get("/favicon.ico", (_req, res) => res.status(204).end());
app.get("/sw.js", (_req, res) => res.setHeader("Content-Type", "application/javascript").status(200).send("// No-op Service Worker\n"));

/* Auth and staff routes sit before the customer authenticate/tenantScope pair:
   signing in cannot itself require being signed in, and staff are a separate
   population with their own session. */
app.use("/api/v1/auth", authRoutes({ db, config: {
  appUrl: env.APP_URL,
  sendEmail: null,   // wire a provider here; until then verification links are logged, not sent
} }));
app.use("/api/v1/admin", adminRoutes({ db }));

app.use("/api/v1", authenticate, tenantScope);

app.use("/api/v1/google", googleRoutes({ db, config: {
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  redirectUri: env.GOOGLE_REDIRECT_URI || (env.API_PUBLIC_URL ? `${env.API_PUBLIC_URL}/api/v1/google/callback` : `${env.API_URL}/api/v1/google/callback`),
  tokenKey: env.TOKEN_ENCRYPTION_KEY,
  webhookUrl: env.GOOGLE_WEBHOOK_URL || (env.API_PUBLIC_URL ? `${env.API_PUBLIC_URL}/api/v1/google/webhook` : `${env.API_URL}/api/v1/google/webhook`),
} }));

app.use("/api/v1", crmRoutes({ db }));
app.use("/api/v1", inboxRoutes({ db, config: {
  gowhatsBaseUrl: env.GOWHATS_BASE_URL,
  gowhatsApiKey: env.GOWHATS_API_KEY,
  gowhatsWebhookSecret: env.GOWHATS_WEBHOOK_SECRET,
} }));
app.use("/api/v1", schedulingRoutes({ db }));
app.use("/api/v1", agentRoutes({ db }));
app.use("/api/v1", workflowRoutes({ db }));
app.use("/api/v1", billingRoutes({ db }));
app.use("/api/v1", integrationRoutes({ db }));

// Domain routes are mounted here as they are ported. Each returns 501 until then,
// which is deliberate: a missing endpoint must fail loudly, not silently succeed.
const DOMAINS = ["pipelines", "segments",
  "calls",
  "campaigns", "knowledge", "approvals", "analytics", "audit",
  "events", "notifications", "files", "buzz"];
for (const d of DOMAINS) {
  app.use(`/api/v1/${d}`, (req, res) =>
    res.status(501).json({
      code: "not_implemented",
      message: `The ${d} API is specified in docs/openapi.yaml but not yet implemented.`,
      request_id: req.id,
      docs: "https://docs.buzzzbuzzz.com/api",
    })
  );
}

app.use(googleErrorHandler);
app.use(errorHandler);

const port = env.PORT;
app.listen(port, () => console.log(`BUZZZ API listening on :${port}`));
