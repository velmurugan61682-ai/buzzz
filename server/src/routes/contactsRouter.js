/**
 * server/src/routes/contactsRouter.js
 *
 * All contacts, missed-calls, and Android sync routes for BUZZZ Platform.
 *
 * Mounted in server.js at:
 *   app.use("/api/v1", contactsRouter);
 *   app.use("/api",    contactsRouter);
 *   app.use("/",       contactsRouter);   ← for /webhooks/* paths
 *
 * Endpoints:
 *   GET    /api/contacts                   — list/search with ?q=, ?phone=, ?page=, ?limit=
 *   GET    /api/contacts/:phone            — single contact + missed-call history
 *   PATCH  /api/contacts/:phone            — update fields
 *   DELETE /api/contacts/:phone            — soft archive
 *   POST   /api/contacts/import/google     — Google People API paginated import
 *   POST   /api/contacts/import/file       — CSV or vCard file upload (multer, max 2 MB)
 *   POST   /api/sync/device-token          — issue JWT for Android companion app
 *   POST   /api/sync/contacts              — Android batch contact sync (JWT required)
 *   POST   /api/sync/calls                 — Android batch missed-call sync (JWT required)
 *   POST   /webhooks/missed-call           — cloud telephony (Exotel/Twilio/Knowlarity/generic)
 *   GET    /api/missed-calls               — paginated missed-call list
 */

import { Router } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import multer from "multer";
import { parse as parseCsv } from "csv-parse/sync";
import {
  fetchContacts,
  fetchContactById,
  upsertContact,
  resolveOrCreateContact,
  saveMissedCall,
  fetchMissedCalls,
  deleteContactById,
  upsertConversation,
  saveUnifiedMessage,
  MissedCallModel,
  ContactModel,
} from "../data/db.js";
import { sanitizeMessage } from "../services/gmailAuth.js";
import {
  normalizePhone,
  importGoogleContacts,
  importCsvContacts,
  importVCardContacts,
  sendMissedCallAutoReply,
} from "../services/contacts.js";

export const contactsRouter = Router();

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Extract workspaceId from JWT (if present on req), header, or query */
const getWorkspaceId = (req) =>
  req.jwtPayload?.workspaceId ||
  req.headers["x-workspace-id"] ||
  req.headers["x-ws-id"] ||
  req.query?.workspaceId ||
  req.query?.workspace_id ||
  req.body?.workspaceId ||
  "ws_default";

// ── Rate limiters ──────────────────────────────────────────────────────────────

/** 30 requests / 60 s per IP on webhook + sync routes */
const syncRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: "rate_limited", message: "Too many requests — try again later." },
});

/** 10 requests / 60 s per IP on the webhook (telephony provider retries) */
const webhookRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: "rate_limited", message: "Webhook rate limit exceeded." },
});

// ── rawBody capture (needed for HMAC verification) ────────────────────────────
/**
 * Middleware: captures req.rawBody as a Buffer before JSON/urlencoded parsing.
 * Must be applied BEFORE express.json() and express.urlencoded() on the webhook route.
 */
const captureRawBody = (req, _res, next) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    req.rawBody = Buffer.concat(chunks);
    // Parse body ourselves so downstream can read req.body normally
    const ct = req.headers["content-type"] || "";
    if (ct.includes("application/json")) {
      try { req.body = JSON.parse(req.rawBody.toString()); } catch (_) { req.body = {}; }
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(req.rawBody.toString());
      req.body = Object.fromEntries(params.entries());
    }
    next();
  });
};

// ── JWT Android auth ───────────────────────────────────────────────────────────

const ANDROID_JWT_SECRET = () => process.env.ANDROID_SYNC_JWT_SECRET || "";
const JWT_EXPIRY = "30d";

/**
 * Middleware: verify Android companion JWT.
 * Attaches decoded payload to req.jwtPayload.
 */
const requireAndroidJwt = (req, res, next) => {
  const secret = ANDROID_JWT_SECRET();
  if (!secret) {
    // Dev mode: bypass if secret not configured
    req.jwtPayload = { workspaceId: "ws_default", deviceId: "dev_default" };
    return next();
  }
  const header = req.headers.authorization || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ code: "unauthorized", message: "Bearer token required." });
  }
  try {
    req.jwtPayload = jwt.verify(token, secret);
    next();
  } catch (err) {
    return res.status(401).json({ code: "unauthorized", message: "Invalid or expired device token." });
  }
};

// ── Multer (CSV/vCard file upload) ─────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB max
  fileFilter: (_req, file, cb) => {
    const ok = /\.(csv|vcf|vcard)$/i.test(file.originalname) ||
               ["text/csv", "text/vcard", "text/x-vcard", "application/octet-stream"].includes(file.mimetype);
    cb(ok ? null : new Error("Only .csv and .vcf files are accepted."), ok);
  },
});

// ==============================================================================
// POST /api/sync/device-token — Issue Android companion JWT
// ==============================================================================
contactsRouter.post("/sync/device-token", syncRateLimiter, async (req, res) => {
  try {
    const secret = ANDROID_JWT_SECRET();
    if (!secret) {
      return res.status(503).json({ code: "not_configured", message: "ANDROID_SYNC_JWT_SECRET is not configured." });
    }

    const { deviceId, workspaceId } = req.body || {};
    if (!deviceId || typeof deviceId !== "string" || deviceId.trim().length < 4) {
      return res.status(400).json({ code: "bad_request", message: "deviceId (string ≥ 4 chars) is required." });
    }

    const wsId  = (workspaceId || "ws_default").trim();
    const token = jwt.sign({ workspaceId: wsId, deviceId: deviceId.trim() }, secret, { expiresIn: JWT_EXPIRY });

    console.log(`🔑 [DEVICE TOKEN] Issued JWT for device '${deviceId}' workspace '${wsId}'.`);
    res.json({ success: true, token, expiresIn: JWT_EXPIRY, workspaceId: wsId });
  } catch (err) {
    console.error("❌ [DEVICE TOKEN] Error:", sanitizeMessage(err.message));
    res.status(500).json({ code: "server_error", message: "Failed to issue device token." });
  }
});

// ==============================================================================
// POST /api/sync/contacts — Android batch contact sync
// ==============================================================================
contactsRouter.post("/sync/contacts", syncRateLimiter, requireAndroidJwt, async (req, res) => {
  try {
    const wsId     = getWorkspaceId(req);
    const deviceId = req.jwtPayload?.deviceId || "dev_unknown";
    const { contacts, consentGiven } = req.body || {};

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ code: "bad_request", message: "contacts[] array is required and must not be empty." });
    }
    if (!consentGiven) {
      return res.status(400).json({ code: "consent_required", message: "consentGiven must be true — user must have agreed to contact sync." });
    }
    if (contacts.length > 500) {
      return res.status(400).json({ code: "batch_too_large", message: "Maximum 500 contacts per request." });
    }

    let imported = 0, skipped = 0, errors = 0;

    for (const c of contacts) {
      try {
        const rawPhone = String(c.phone || c.mobile || c.phoneNumber || "").trim();
        const email    = String(c.email || "").toLowerCase().trim();
        const name     = String(c.name || c.displayName || rawPhone || email || "Unknown").trim();

        if (!rawPhone && !email) { skipped++; continue; }

        const e164   = normalizePhone(rawPhone);
        const digits = rawPhone.replace(/\D/g, "");

        const contact = await resolveOrCreateContact({
          workspaceId: wsId,
          name,
          email,
          phone: e164 ? e164.replace(/\D/g, "") : digits,
          identities: [
            ...(email ? [{ type: "email", value: email }] : []),
            ...(e164  ? [{ type: "phone", value: e164  }] : []),
          ],
          source: "android_sync",
          channel: rawPhone ? "whatsapp" : "email",
        });

        const patch = { consentGiven: true, consentAt: new Date(), syncSource: "android_companion", deviceId };
        if (e164) patch.phone_e164 = e164;
        await upsertContact({ ...contact, ...patch }).catch(() => null);

        imported++;
      } catch (rowErr) {
        errors++;
        console.warn("⚠️ [ANDROID SYNC] Contact row error:", sanitizeMessage(rowErr.message));
      }
    }

    console.log(`✅ [ANDROID SYNC] Contacts: total=${contacts.length} imported=${imported} skipped=${skipped} errors=${errors}`);
    res.json({ success: true, imported, skipped, errors, total: contacts.length });
  } catch (err) {
    console.error("❌ [ANDROID SYNC] /sync/contacts error:", sanitizeMessage(err.message));
    res.status(500).json({ code: "server_error", message: "Failed to sync contacts." });
  }
});

// ==============================================================================
// POST /api/sync/calls — Android batch missed-call sync
// ==============================================================================
contactsRouter.post("/sync/calls", syncRateLimiter, requireAndroidJwt, async (req, res) => {
  try {
    const wsId     = getWorkspaceId(req);
    const deviceId = req.jwtPayload?.deviceId || "dev_unknown";
    const { calls, consentGiven } = req.body || {};

    if (!Array.isArray(calls) || calls.length === 0) {
      return res.status(400).json({ code: "bad_request", message: "calls[] array is required and must not be empty." });
    }
    if (!consentGiven) {
      return res.status(400).json({ code: "consent_required", message: "consentGiven must be true — user must have agreed to call log sync." });
    }
    if (calls.length > 200) {
      return res.status(400).json({ code: "batch_too_large", message: "Maximum 200 calls per request." });
    }

    let synced = 0, skipped = 0, errors = 0;

    for (const call of calls) {
      try {
        const rawPhone  = String(call.phone || call.phoneNumber || call.number || "").trim();
        const callType  = String(call.type  || call.callType  || "MISSED").toUpperCase();
        const calledAt  = call.calledAt || call.timestamp || call.date || new Date().toISOString();

        if (!rawPhone) { skipped++; continue; }

        const e164   = normalizePhone(rawPhone);
        const digits = rawPhone.replace(/\D/g, "");

        // Dedup: use provided externalCallId, or derive a hash from phone+timestamp+type
        const { createHash } = await import("crypto");
        const extId = call.externalCallId || call.callId ||
          `call_${deviceId}_${createHash("sha1").update(`${digits}|${calledAt}|${callType}`).digest("hex").slice(0, 16)}`;

        const contact = await resolveOrCreateContact({
          workspaceId: wsId,
          name: call.name || call.contactName || "Unknown Caller",
          phone: e164 ? e164.replace(/\D/g, "") : digits,
          source: "android_sync",
          channel: "voice",
        });

        const { isNew } = await saveMissedCall({
          userId:        "usr_default",
          deviceId,
          phoneNumber:   e164 || rawPhone,
          contactName:   contact.name,
          type:          callType,
          calledAt:      new Date(calledAt),
          syncSource:    "android_companion",
          externalCallId: extId,
          contactId:     contact.id,
        });

        if (!isNew) { skipped++; continue; }

        synced++;
      } catch (rowErr) {
        errors++;
        console.warn("⚠️ [ANDROID SYNC] Call row error:", sanitizeMessage(rowErr.message));
      }
    }

    console.log(`✅ [ANDROID SYNC] Calls: total=${calls.length} synced=${synced} skipped=${skipped} errors=${errors}`);
    res.json({ success: true, synced, skipped, errors, total: calls.length });
  } catch (err) {
    console.error("❌ [ANDROID SYNC] /sync/calls error:", sanitizeMessage(err.message));
    res.status(500).json({ code: "server_error", message: "Failed to sync calls." });
  }
});

// ==============================================================================
// POST /webhooks/missed-call — Cloud telephony webhook
// ==============================================================================
//
// Supported providers (auto-detected from body shape):
//   • Twilio   — CallSid, From, To, CallStatus, Timestamp fields + X-Twilio-Signature
//   • Exotel   — CallSid, From, To, Status, StartTime fields
//   • Knowlarity — caller_number, called_number, call_status, call_id fields
//   • Generic  — any of the above, verified by x-webhook-secret header
//
contactsRouter.post(
  "/webhooks/missed-call",
  webhookRateLimiter,
  captureRawBody,   // must come before any body-parser for rawBody to work
  async (req, res) => {
    // ALWAYS respond 200 quickly; do all processing after res.end()
    let responded = false;
    const respond = () => {
      if (!responded) {
        responded = true;
        res.status(200).json({ received: true });
      }
    };

    try {
      // ── Signature / secret verification ──────────────────────────────────────
      const secret   = process.env.MISSED_CALL_WEBHOOK_SECRET || "";
      const provider = (process.env.MISSED_CALL_WEBHOOK_PROVIDER || "generic").toLowerCase();

      if (secret) {
        const verifyGeneric = () => {
          const incoming = req.headers["x-webhook-secret"] || req.headers["x-secret"] || "";
          try {
            return timingSafeEqual(Buffer.from(incoming), Buffer.from(secret));
          } catch (_) {
            return false;
          }
        };

        const verifyHmac = (sigHeader) => {
          const sig = req.headers[sigHeader] || "";
          const raw = req.rawBody || Buffer.from(JSON.stringify(req.body));
          const mac = createHmac("sha256", secret).update(raw).digest("hex");
          try {
            return timingSafeEqual(Buffer.from(sig), Buffer.from(mac));
          } catch (_) {
            return false;
          }
        };

        const verifyTwilio = () => {
          // Twilio uses HMAC-SHA1 over the full URL + sorted body params
          const twilioSig = req.headers["x-twilio-signature"] || "";
          if (!twilioSig) return false;
          const url    = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
          const params = req.body || {};
          const sorted = Object.keys(params).sort().reduce((s, k) => s + k + params[k], url);
          const mac    = createHmac("sha1", secret).update(sorted).digest("base64");
          try {
            return timingSafeEqual(Buffer.from(twilioSig), Buffer.from(mac));
          } catch (_) {
            return false;
          }
        };

        let verified = false;
        if (provider === "twilio") {
          verified = verifyTwilio();
        } else if (provider === "exotel" || provider === "knowlarity") {
          verified = verifyHmac("x-exotel-signature") || verifyHmac("x-signature") || verifyGeneric();
        } else {
          // generic: accept HMAC header or plain shared-secret header
          verified = verifyHmac("x-signature") || verifyGeneric();
        }

        if (!verified) {
          console.warn("⚠️ [WEBHOOK MISSED-CALL] Rejected: invalid signature / secret.");
          return res.status(401).json({ code: "unauthorized", message: "Invalid webhook signature." });
        }
      }

      const body = req.body || {};

      // ── Normalise body across providers ──────────────────────────────────────
      // Twilio: CallSid, From, To, CallStatus, Timestamp / StartTime
      // Exotel: CallSid, From, To, Status, StartTime
      // Knowlarity: call_id, caller_number, called_number, call_status, call_start_time
      // Generic: caller_number / From / from, called_number / To / to, call_sid, timestamp
      const callerRaw  = body.caller_number || body.From   || body.from  || body.CallerNumber || "";
      const calledRaw  = body.called_number || body.To     || body.to    || body.To           || "";
      const callSid    = body.call_id || body.CallSid || body.call_sid   || `gen_${Date.now()}`;
      const rawStatus  = (body.call_status || body.CallStatus || body.Status || "no-answer").toLowerCase();
      const timestampRaw = body.call_start_time || body.Timestamp || body.StartTime || body.timestamp || new Date().toISOString();

      // Only process genuine missed / no-answer calls
      const isMissed = ["no-answer", "missed", "noanswer", "busy", "no_answer"].includes(rawStatus.replace(/[\s_]/g, "-").toLowerCase());
      if (!isMissed) {
        console.log(`ℹ️ [WEBHOOK MISSED-CALL] Skipping event with status='${rawStatus}' (not a missed call).`);
        return respond();
      }

      if (!callerRaw) {
        console.warn("⚠️ [WEBHOOK MISSED-CALL] No caller number in payload.");
        return respond();
      }

      // Respond IMMEDIATELY — all further processing is async
      respond();

      // ── Async processing (runs after 200 is sent) ─────────────────────────
      setImmediate(async () => {
        try {
          const wsId   = "ws_default"; // webhooks always go to default workspace
          const e164   = normalizePhone(callerRaw) || callerRaw;
          const digits = e164.replace(/\D/g, "");
          const calledAt = new Date(timestampRaw).toISOString();

          // Dedup: use call_sid as externalCallId
          const extId = `webhook_${callSid}`;

          // 1. Resolve / create contact
          const contact = await resolveOrCreateContact({
            workspaceId: wsId,
            name: "Unknown Caller",
            phone: digits,
            source: "missed_call",
            channel: "voice",
          });

          // Persist E.164 onto contact
          if (e164 && e164 !== digits && !contact.phone_e164) {
            await upsertContact({ ...contact, phone_e164: e164, source: "missed_call" }).catch(() => null);
          }

          // 2. Save missed call (dedup by externalCallId)
          const { doc: callDoc, isNew } = await saveMissedCall({
            userId:         "usr_default",
            deviceId:       "webhook",
            phoneNumber:    e164,
            contactName:    contact.name,
            type:           "MISSED",
            calledAt:       new Date(calledAt),
            syncSource:     provider,
            externalCallId: extId,
            contactId:      contact.id,
          });

          if (!isNew) {
            console.log(`ℹ️ [WEBHOOK MISSED-CALL] Duplicate ignored: ${extId}`);
            return;
          }

          // 3. Upsert conversation for Inbox display
          const convId = `conv_missed_${digits}`;
          const conv   = await upsertConversation({
            id:          convId,
            workspaceId: wsId,
            customerName: contact.name,
            channel:     "Missed Call",
            phone:       digits,
            unreadCount: 1,
            lastMessage: `Missed call from ${contact.name} (${e164})`,
            updatedAt:   calledAt,
          });

          // 4. Unified inbox message
          await saveUnifiedMessage({
            id:               `msg_wh_missed_${callDoc.id}`,
            workspaceId:      wsId,
            conversationId:   conv.id,
            integrationId:    "missed_call",
            platform:         "missed_call",
            externalMessageId: extId,
            sender:           { name: contact.name, phone: e164, kind: "customer" },
            direction:        "inbound",
            text:             `Missed call received at ${new Date(calledAt).toLocaleString()} (via ${provider})`,
            status:           "received",
            receivedAt:       new Date(calledAt),
            metadata:         { provider, callSid, calledNumber: calledRaw, rawStatus },
          });

          console.log(`📞 [WEBHOOK MISSED-CALL] Stored: ${e164} → conv '${convId}' (${provider})`);

          // 5. Auto-reply (throttled, fire-and-forget)
          sendMissedCallAutoReply(e164, contact.name).catch(() => null);
        } catch (asyncErr) {
          console.error("❌ [WEBHOOK MISSED-CALL] Async processing error:", sanitizeMessage(asyncErr.message));
        }
      });
    } catch (err) {
      console.error("❌ [WEBHOOK MISSED-CALL] Outer error:", sanitizeMessage(err.message));
      respond(); // still respond 200 to prevent provider retries on our errors
    }
  }
);

// ==============================================================================
// GET /api/missed-calls — Paginated missed-call list
// ==============================================================================
contactsRouter.get("/missed-calls", async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || "20",  10), 100);
    const page   = Math.max(parseInt(req.query.page   || "1",   10), 1);
    const result = await fetchMissedCalls(null, limit, page);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ code: "server_error", message: "Failed to fetch missed calls." });
  }
});

// ==============================================================================
// POST /api/contacts/import/google — Google People API import
// ==============================================================================
contactsRouter.post("/contacts/import/google", async (req, res) => {
  try {
    const wsId   = getWorkspaceId(req);
    const result = await importGoogleContacts(wsId);

    if (!result.success) {
      const status = result.error === "no_account" || result.error === "token_expired" ? 401 : 502;
      return res.status(status).json(result);
    }

    res.json({
      success:        true,
      imported:       result.imported,
      skipped:        result.skipped,
      errors:         result.errors,
      hasSyncToken:   Boolean(result.nextSyncToken),
      message:        `Imported ${result.imported} contact(s) from Google (${result.skipped} skipped, ${result.errors} error(s)).`,
    });
  } catch (err) {
    console.error("❌ [CONTACTS/IMPORT/GOOGLE]", sanitizeMessage(err.message));
    res.status(500).json({ code: "server_error", message: "Google Contacts import failed." });
  }
});

// ==============================================================================
// POST /api/contacts/import/file — CSV / vCard file upload
// ==============================================================================
contactsRouter.post("/contacts/import/file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ code: "no_file", message: "Upload a .csv or .vcf file using the 'file' field." });
    }

    const wsId        = getWorkspaceId(req);
    const consentGiven = String(req.body?.consentGiven || "false").toLowerCase() === "true";
    const filename    = req.file.originalname.toLowerCase();
    const content     = req.file.buffer.toString("utf8");

    let result;
    if (filename.endsWith(".vcf") || filename.endsWith(".vcard")) {
      result = await importVCardContacts(wsId, content, consentGiven);
    } else {
      // CSV: parse with csv-parse (sync, tolerant)
      let rows;
      try {
        rows = parseCsv(content, {
          columns:          true,
          skip_empty_lines: true,
          trim:             true,
          relax_column_count: true,
        });
      } catch (parseErr) {
        return res.status(400).json({ code: "parse_error", message: `CSV parse error: ${parseErr.message}` });
      }
      result = await importCsvContacts(wsId, rows, consentGiven);
    }

    if (!result.success) return res.status(400).json(result);

    res.json({
      ...result,
      message: `Imported ${result.imported} contact(s) from file (${result.skipped} skipped, ${result.errors} error(s)).`,
    });
  } catch (err) {
    if (err.message?.includes("Only .csv")) {
      return res.status(400).json({ code: "invalid_file_type", message: err.message });
    }
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ code: "file_too_large", message: "File exceeds 2 MB limit." });
    }
    console.error("❌ [CONTACTS/IMPORT/FILE]", sanitizeMessage(err.message));
    res.status(500).json({ code: "server_error", message: "File import failed." });
  }
});

// ==============================================================================
// GET /api/contacts — List / search contacts (with pagination)
// ==============================================================================
contactsRouter.get("/contacts", async (req, res) => {
  try {
    const wsId   = getWorkspaceId(req);
    const q      = String(req.query.q || req.query.search || "").trim().toLowerCase();
    const phone  = String(req.query.phone || "").trim();
    const page   = Math.max(parseInt(req.query.page  || "1",  10), 1);
    const limit  = Math.min(parseInt(req.query.limit || "50", 10), 200);

    let contacts = await fetchContacts(wsId);

    // Filter by search query or exact phone
    if (q) {
      contacts = contacts.filter((c) =>
        (c.name  && c.name.toLowerCase().includes(q)) ||
        (c.phone && c.phone.includes(q.replace(/\D/g, ""))) ||
        (c.email && c.email.toLowerCase().includes(q))
      );
    }
    if (phone) {
      const digits = phone.replace(/\D/g, "");
      contacts = contacts.filter((c) => c.phone && c.phone.replace(/\D/g, "") === digits);
    }

    const total  = contacts.length;
    const paged  = contacts.slice((page - 1) * limit, page * limit);

    res.json({
      success:  true,
      contacts: paged,
      count:    paged.length,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ code: "server_error", message: "Failed to fetch contacts." });
  }
});

// ==============================================================================
// GET /api/contacts/:phone — Single contact with missed-call history
// ==============================================================================
contactsRouter.get("/contacts/:phone", async (req, res) => {
  try {
    const { phone } = req.params;
    const contact   = await fetchContactById(phone);
    if (!contact) {
      return res.status(404).json({ success: false, code: "not_found", message: `Contact '${phone}' not found.` });
    }

    // Fetch missed calls for this contact's phone number
    const digits = String(contact.phone || phone).replace(/\D/g, "");
    let missedCalls = [];
    try {
      if (MissedCallModel) {
        const docs = await MissedCallModel.find({ phoneNumber: { $regex: digits + "$" } })
          .sort({ calledAt: -1 })
          .limit(50)
          .lean();
        missedCalls = docs;
      }
    } catch (_) {}

    res.json({ success: true, contact, missedCalls });
  } catch (err) {
    res.status(500).json({ code: "server_error", message: "Failed to fetch contact." });
  }
});

// ==============================================================================
// PATCH /api/contacts/:phone — Update contact fields
// ==============================================================================
contactsRouter.patch("/contacts/:phone", async (req, res) => {
  try {
    const { phone }  = req.params;
    const contact    = await fetchContactById(phone);
    if (!contact) {
      return res.status(404).json({ success: false, code: "not_found", message: `Contact '${phone}' not found.` });
    }

    // Build safe update (strip internal fields callers shouldn't overwrite)
    const { id: _id, workspaceId: _ws, _id: __id, ...updates } = req.body || {};

    // Normalize phone_e164 if phone is being updated
    if (updates.phone) {
      const e164 = normalizePhone(updates.phone);
      if (e164) updates.phone_e164 = e164;
      updates.phone = e164 ? e164.replace(/\D/g, "") : updates.phone.replace(/\D/g, "");
    }

    const saved = await upsertContact({ ...contact, ...updates });
    res.json({ success: true, contact: saved });
  } catch (err) {
    res.status(500).json({ code: "server_error", message: "Failed to update contact." });
  }
});

// ==============================================================================
// DELETE /api/contacts/:phone — Soft archive a contact
// ==============================================================================
contactsRouter.delete("/contacts/:phone", async (req, res) => {
  try {
    const { phone } = req.params;
    const contact   = await fetchContactById(phone);
    if (!contact) {
      return res.status(404).json({ success: false, code: "not_found", message: `Contact '${phone}' not found.` });
    }
    await upsertContact({ ...contact, archived: true });
    res.json({ success: true, archived: true, id: contact.id });
  } catch (err) {
    res.status(500).json({ code: "server_error", message: "Failed to archive contact." });
  }
});
