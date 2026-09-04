/**
 * Deduplicate Contacts CLI Tool
 *
 * Scans contacts per workspace for email or phone collisions,
 * selects the canonical (most complete / active) record, and merges duplicates.
 *
 * Usage:
 *   node scripts/dedupe-contacts.mjs --workspace <workspaceId> [--dry-run]
 *   node scripts/dedupe-contacts.mjs --all-workspaces [--dry-run]
 */

import pg from "pg";
import { createDb, normalizeEmail, normalizePhone } from "../server/src/lib/db.js";
import { env } from "../server/src/config/env.js";

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const allWorkspaces = args.includes("--all-workspaces");
const wsIdx = args.indexOf("--workspace");
const targetWorkspaceId = wsIdx !== -1 ? args[wsIdx + 1] : null;

if (!targetWorkspaceId && !allWorkspaces) {
  console.log("Usage: node scripts/dedupe-contacts.mjs [--workspace <id> | --all-workspaces] [--dry-run]");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const db = createDb(pool);

function calculateCompletenessScore(contact) {
  let score = 0;
  if (contact.email) score += 10;
  if (contact.phone) score += 10;
  if (contact.name && contact.name.trim() !== "") score += 5;
  if (contact.company) score += 5;
  if (contact.source) score += 2;
  if (contact.owner_id) score += 2;
  if (contact.updated_at) {
    score += new Date(contact.updated_at).getTime() / 1e12; // Tie breaker for recent activity
  }
  return score;
}

async function dedupeWorkspace(workspaceId) {
  console.log(`\nScanning workspace: ${workspaceId} (dry-run: ${isDryRun})...`);
  const contacts = await db.listContacts(workspaceId, { limit: 1000, offset: 0 });

  const emailGroups = new Map();
  const phoneGroups = new Map();

  for (const c of contacts) {
    const normE = normalizeEmail(c.email);
    if (normE) {
      if (!emailGroups.has(normE)) emailGroups.set(normE, []);
      emailGroups.get(normE).push(c);
    }

    const normP = c.phone_norm || normalizePhone(c.phone);
    if (normP) {
      if (!phoneGroups.has(normP)) phoneGroups.set(normP, []);
      phoneGroups.get(normP).push(c);
    }
  }

  const dupPairs = new Map(); // key: "canonicalId:duplicateId"

  const processGroups = (groups, label) => {
    for (const [key, group] of groups.entries()) {
      if (group.length > 1) {
        // Sort descending by completeness score
        group.sort((a, b) => calculateCompletenessScore(b) - calculateCompletenessScore(a));
        const canonical = group[0];
        for (let i = 1; i < group.length; i++) {
          const duplicate = group[i];
          const pairKey = `${canonical.id}:${duplicate.id}`;
          if (!dupPairs.has(pairKey)) {
            dupPairs.set(pairKey, { canonical, duplicate, reason: `Collision on ${label}: ${key}` });
          }
        }
      }
    }
  };

  processGroups(emailGroups, "email");
  processGroups(phoneGroups, "phone");

  if (dupPairs.size === 0) {
    console.log("  No duplicate contacts found.");
    return 0;
  }

  console.log(`  Found ${dupPairs.size} duplicate contact merge pair(s):`);
  let mergedCount = 0;

  for (const { canonical, duplicate, reason } of dupPairs.values()) {
    console.log(`  - [MERGE] Canonical: ${canonical.id} (${canonical.name || canonical.email}), Duplicate: ${duplicate.id} (${duplicate.name || duplicate.email}) | ${reason}`);
    if (!isDryRun) {
      try {
        await db.mergeContacts(workspaceId, canonical.id, duplicate.id);
        mergedCount++;
      } catch (err) {
        console.error(`    FAILED to merge ${duplicate.id} into ${canonical.id}: ${err.message}`);
      }
    }
  }

  if (isDryRun) {
    console.log(`  [DRY RUN] Would have merged ${dupPairs.size} contact pair(s).`);
  } else {
    console.log(`  Successfully merged ${mergedCount} contact pair(s).`);
  }

  return dupPairs.size;
}

async function main() {
  try {
    if (allWorkspaces) {
      const res = await pool.query("SELECT id FROM workspaces WHERE status <> 'deleted'");
      for (const row of res.rows) {
        await dedupeWorkspace(row.id);
      }
    } else {
      await dedupeWorkspace(targetWorkspaceId);
    }
  } catch (err) {
    console.error("Deduplication error:", err);
  } finally {
    await pool.end();
  }
}

main();
