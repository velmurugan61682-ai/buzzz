/**
 * server/src/services/contacts.js
 *
 * Centralised Contacts service for BUZZZ Platform.
 *   - E.164 phone normalisation (libphonenumber-js/min, default country IN)
 *   - Google People API — full paginated import + syncToken delta-sync
 *   - CSV / vCard batch import with consent flag
 *   - Missed-call WhatsApp auto-reply with per-number throttle
 *
 * NEVER logs or exposes raw secrets.
 */

import { parsePhoneNumber } from "libphonenumber-js/min";
import {
  resolveOrCreateContact,
  upsertContact,
  getSystemSetting,
  setSystemSetting,
} from "../data/db.js";
import { getValidGoogleAccount, sanitizeMessage } from "./gmailAuth.js";
import { sendWhatsAppMessage } from "./gowhats.js";

// ── Config ─────────────────────────────────────────────────────────────────────
const DEFAULT_COUNTRY = "IN";
const GOOGLE_PEOPLE_PAGE_SIZE = 200; // People API max per page
const SYNC_TOKEN_KEY_PFX = "googleContactsSyncToken_";
const AUTO_REPLY_THROTTLE_MS =
  parseInt(process.env.MISSED_CALL_AUTO_REPLY_THROTTLE_MINUTES || "60", 10) * 60_000;

/** In-process throttle: phone_e164 → last-auto-reply timestamp */
const autoReplyThrottle = new Map();

// ==============================================================================
// 1. PHONE NORMALISATION
// ==============================================================================

/**
 * Normalise any raw phone string to E.164 ("+919876543210").
 * Returns null when input has fewer than 7 digits (clearly invalid).
 *
 * Strategy (in order):
 *  1. Parse as-is with defaultCountry hint.
 *  2. 10-digit input → assume Indian mobile (+91).
 *  3. Multi-digit without leading + → prepend + and retry.
 *
 * @param {string|null|undefined} raw
 * @param {string} [country]  ISO 3166-1 alpha-2 default (default "IN")
 * @returns {string|null}
 */
export function normalizePhone(raw, country = DEFAULT_COUNTRY) {
  if (!raw) return null;
  const str = String(raw).trim();
  const digits = str.replace(/\D/g, "");
  if (digits.length < 7) return null;

  // Attempt 1: parse as-is
  try {
    const p = parsePhoneNumber(str, country);
    if (p && p.isValid()) return p.format("E.164");
  } catch (_) {}

  // Attempt 2: 10-digit → assume IN mobile
  if (digits.length === 10) {
    try {
      const p = parsePhoneNumber(`+91${digits}`, "IN");
      if (p && p.isValid()) return p.format("E.164");
    } catch (_) {}
  }

  // Attempt 3: prefix + and retry (handles 11+ digit strings without +)
  if (!str.startsWith("+")) {
    try {
      const p = parsePhoneNumber(`+${digits}`, country);
      if (p && p.isValid()) return p.format("E.164");
    } catch (_) {}
  }

  return null;
}

// ==============================================================================
// 2. GOOGLE PEOPLE API — PAGINATED IMPORT WITH SYNCTOKEN
// ==============================================================================

/**
 * Import / delta-sync Google Contacts for a workspace.
 *
 * First run: full sync (requestSyncToken=true), saves nextSyncToken.
 * Subsequent runs: delta sync (syncToken=<stored>).
 * 410 GONE (expired token): clears stored token, retries full sync once.
 *
 * @param {string} workspaceId
 * @returns {Promise<{success:boolean,imported:number,skipped:number,errors:number,nextSyncToken:string|null}>}
 */
export async function importGoogleContacts(workspaceId = "ws_default") {
  const account = await getValidGoogleAccount(workspaceId);
  if (!account?.accessToken) {
    return { success: false, error: "no_account", message: "No Google account connected." };
  }
  if (account.isExpired || account.needsReauth) {
    return { success: false, error: "token_expired", message: "Google token expired — re-auth required.", reauthUrl: "/api/google/auth" };
  }

  const syncKey = `${SYNC_TOKEN_KEY_PFX}${workspaceId}`;
  const stored  = await getSystemSetting(syncKey, null);

  const baseQs = {
    personFields: "names,emailAddresses,phoneNumbers",
    pageSize:     String(GOOGLE_PEOPLE_PAGE_SIZE),
  };
  if (stored) {
    baseQs.syncToken = stored;
    console.log(`🔄 [GOOGLE CONTACTS] Delta-sync '${workspaceId}' (syncToken found).`);
  } else {
    baseQs.requestSyncToken = "true";
    console.log(`🔄 [GOOGLE CONTACTS] Full sync '${workspaceId}' (no syncToken).`);
  }

  let imported = 0, skipped = 0, errors = 0;
  let pageToken = null, nextSyncToken = null, page = 0;

  do {
    const qs  = new URLSearchParams({ ...baseQs, ...(pageToken ? { pageToken } : {}) });
    const url = `https://people.googleapis.com/v1/people/me/connections?${qs}`;
    let data;

    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${account.accessToken}` } });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const msg     = errBody.error?.message || `HTTP ${res.status}`;

        if (res.status === 410) {
          // syncToken expired → full-sync retry
          console.warn("⚠️ [GOOGLE CONTACTS] syncToken expired (410). Clearing and retrying full sync.");
          await setSystemSetting(syncKey, null);
          return importGoogleContacts(workspaceId);
        }
        if (res.status === 401 || res.status === 403) {
          return { success: false, error: "insufficient_scope", message: "contacts.readonly scope missing. Re-authorize Google account.", reauthUrl: "/api/google/auth" };
        }
        return { success: false, error: "api_error", message: sanitizeMessage(msg) };
      }

      data = await res.json().catch(() => ({}));
    } catch (netErr) {
      return { success: false, error: "network_error", message: sanitizeMessage(netErr.message) };
    }

    const connections = Array.isArray(data.connections) ? data.connections : [];
    page++;

    for (const person of connections) {
      try {
        const resourceName = person.resourceName || "";
        const name =
          person.names?.[0]?.displayName ||
          [person.names?.[0]?.givenName, person.names?.[0]?.familyName].filter(Boolean).join(" ") ||
          "Unnamed Contact";
        const email    = person.emailAddresses?.[0]?.value?.trim().toLowerCase() || "";
        const rawPhone = person.phoneNumbers?.[0]?.value || "";
        const e164     = normalizePhone(rawPhone);
        const digits   = rawPhone.replace(/\D/g, "");

        if (!name && !email && !rawPhone) { skipped++; continue; }

        const contact = await resolveOrCreateContact({
          workspaceId,
          name,
          email,
          phone: e164 ? e164.replace(/\D/g, "") : digits,
          identities: [
            ...(email        ? [{ type: "email",          value: email }]        : []),
            ...(e164         ? [{ type: "phone",          value: e164 }]         : []),
            ...(resourceName ? [{ type: "google_contact", value: resourceName }] : []),
          ],
          source: "google",
          channel: email ? "email" : "whatsapp",
        });

        // Write phone_e164 — resolveOrCreateContact doesn't know this field yet
        if (e164 && contact && !contact.phone_e164) {
          await upsertContact({ ...contact, phone_e164: e164 }).catch(() => null);
        }

        imported++;
      } catch (personErr) {
        errors++;
        console.warn("⚠️ [GOOGLE CONTACTS] Upsert error:", sanitizeMessage(personErr.message));
      }
    }

    nextSyncToken = data.nextSyncToken || nextSyncToken;
    pageToken     = data.nextPageToken  || null;
    console.log(`📄 [GOOGLE CONTACTS] Page ${page}: ${connections.length} person(s) — imported=${imported} skipped=${skipped} errors=${errors}`);
  } while (pageToken);

  if (nextSyncToken) {
    await setSystemSetting(syncKey, nextSyncToken);
    console.log(`✅ [GOOGLE CONTACTS] nextSyncToken saved for '${workspaceId}'.`);
  }

  return { success: true, imported, skipped, errors, nextSyncToken };
}

// ==============================================================================
// 3. CSV IMPORT
// ==============================================================================

/**
 * Import contacts from an array of plain-object CSV rows.
 * Column names are matched case-insensitively with underscore/hyphen/space flex.
 *
 * @param {string} workspaceId
 * @param {Array<Record<string,string>>} rows  Parsed CSV rows
 * @param {boolean} [consentGiven=false]
 */
export async function importCsvContacts(workspaceId, rows, consentGiven = false) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { success: false, error: "empty_file", message: "CSV has no data rows." };
  }

  let imported = 0, skipped = 0, errors = 0;

  for (const row of rows) {
    try {
      /** Pick first matching column value (case-insensitive, _/- normalised) */
      const col = (candidates) => {
        for (const key of candidates) {
          const found = Object.keys(row).find(
            (c) => c.toLowerCase().replace(/[\s\-]/g, "_") === key
          );
          if (found && row[found]) return String(row[found]).trim();
        }
        return "";
      };

      const firstName = col(["first_name", "firstname", "given_name"]);
      const lastName  = col(["last_name",  "lastname",  "family_name", "surname"]);
      const fullName  =
        col(["name", "full_name", "display_name"]) ||
        [firstName, lastName].filter(Boolean).join(" ");
      const rawPhone = col(["phone", "mobile", "phone_number", "mobile_number", "tel"]);
      const email    = col(["email", "email_address"]).toLowerCase();
      const company  = col(["company", "organization", "organisation", "employer"]);
      const rawTags  = col(["tags", "labels", "groups"]);
      const tags     = rawTags ? rawTags.split(/[,;|]/).map((t) => t.trim()).filter(Boolean) : [];

      if (!fullName && !rawPhone && !email) { skipped++; continue; }

      const e164   = normalizePhone(rawPhone);
      const digits = rawPhone.replace(/\D/g, "");

      const contact = await resolveOrCreateContact({
        workspaceId,
        name: fullName || rawPhone || email,
        email,
        phone: e164 ? e164.replace(/\D/g, "") : digits,
        identities: [
          ...(email ? [{ type: "email", value: email }] : []),
          ...(e164  ? [{ type: "phone", value: e164  }] : []),
        ],
        source: "csv",
        channel: email ? "email" : rawPhone ? "whatsapp" : null,
      });

      // Apply extra fields that resolveOrCreateContact can't set
      const patch = {};
      if (e164)         patch.phone_e164   = e164;
      if (company)      patch.company      = company;
      if (tags.length)  patch.tags         = [...new Set([...(contact?.tags || []), ...tags])];
      if (consentGiven) { patch.consentGiven = true; patch.consentAt = new Date(); }
      if (Object.keys(patch).length) await upsertContact({ ...contact, ...patch }).catch(() => null);

      imported++;
    } catch (rowErr) {
      errors++;
      console.warn("⚠️ [CSV IMPORT] Row error:", sanitizeMessage(rowErr.message));
    }
  }

  console.log(`✅ [CSV IMPORT] total=${rows.length} imported=${imported} skipped=${skipped} errors=${errors}`);
  return { success: true, imported, skipped, errors, total: rows.length };
}

// ==============================================================================
// 4. VCARD IMPORT
// ==============================================================================

/**
 * Minimal vCard 3.0/4.0 parser — no external dependency.
 * Extracts FN/N (name), TEL, and EMAIL from each BEGIN:VCARD block.
 *
 * @param {string} workspaceId
 * @param {string} vcfString  Raw .vcf file content
 * @param {boolean} [consentGiven=false]
 */
export async function importVCardContacts(workspaceId, vcfString, consentGiven = false) {
  const blocks = vcfString.split(/BEGIN:VCARD/i).slice(1);
  const rows   = blocks.map((block) => {
    const lines  = block.split(/\r?\n/).map((l) => l.trim());
    const pick   = (pfx) =>
      lines
        .find((l) => l.toLowerCase().startsWith(pfx.toLowerCase()))
        ?.split(":")
        .slice(1)
        .join(":")
        .trim() || "";
    const pickAll = (pfx) =>
      lines
        .filter((l) => l.toLowerCase().startsWith(pfx.toLowerCase()))
        .map((l) => l.split(":").slice(1).join(":").trim())
        .filter(Boolean);

    // FN (full name) or N (structured name; semicolons → spaces)
    const fn    = pick("FN") || pick("N").replace(/;+/g, " ").trim();
    const tel   = pickAll("TEL")[0] || "";
    const email = (pick("EMAIL") || "").toLowerCase();
    return { name: fn, phone: tel, email };
  });

  return importCsvContacts(workspaceId, rows, consentGiven);
}

// ==============================================================================
// 5. MISSED-CALL AUTO-REPLY THROTTLE
// ==============================================================================

/**
 * Send a WhatsApp auto-reply after a missed call.
 * Throttled to at most 1 message per phone per AUTO_REPLY_THROTTLE_MS.
 * Must be called AFTER HTTP 200 is returned (fire-and-forget async).
 *
 * Uses {{name}} placeholder in MISSED_CALL_AUTO_REPLY_TEXT env var.
 *
 * @param {string} phone_e164  E.164 caller number
 * @param {string} [callerName]
 */
export async function sendMissedCallAutoReply(phone_e164, callerName) {
  if (!phone_e164) return;
  if (process.env.AUTO_REPLY_ON_MISSED_CALL !== "true") return;

  const now      = Date.now();
  const lastSent = autoReplyThrottle.get(phone_e164) || 0;
  if (now - lastSent < AUTO_REPLY_THROTTLE_MS) {
    console.log(`🔕 [AUTO-REPLY] Throttled ${phone_e164} (sent ${Math.round((now - lastSent) / 60_000)}m ago).`);
    return;
  }
  autoReplyThrottle.set(phone_e164, now);

  const tpl  =
    process.env.MISSED_CALL_AUTO_REPLY_TEXT ||
    "Hi {{name}}! We missed your call. Our team will call you back shortly. — BUZZZ Team";
  const text = tpl.replace(/\{\{name\}\}/g, callerName || "there");
  const to   = phone_e164.replace(/\D/g, "");

  try {
    await sendWhatsAppMessage({ to, text });
    console.log(`✅ [AUTO-REPLY] Sent to ${phone_e164}`);
  } catch (err) {
    autoReplyThrottle.delete(phone_e164); // allow retry next time
    console.warn(`⚠️ [AUTO-REPLY] Failed ${phone_e164}:`, sanitizeMessage(err.message));
  }
}
