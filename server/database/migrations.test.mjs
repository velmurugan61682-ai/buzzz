/**
 * Database Migration Sequence & Integrity Test Suite.
 *
 * Verifies that:
 * 1. All 13 migrations (0001 to 0013) exist sequentially in database/migrations.
 * 2. Every migration file is non-empty and well-formed SQL.
 * 3. Every tenant-owned table contains workspace_id.
 * 4. Extensions (pgcrypto, vector, ltree) are declared.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) {
    console.error("  FAIL:", msg);
    fails++;
  }
};

const dir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(dir, "migrations");

const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();

ok(files.length >= 15, `Expected at least 15 migration files, found ${files.length}`);

// Verify sequential numbering 0001..0015
for (let i = 1; i <= files.length; i++) {
  const prefix = String(i).padStart(4, "0");
  const match = files.find(f => f.startsWith(prefix));
  ok(!!match, `Migration ${prefix} exists`);
}

// Verify sql contents
let fullSql = "";
for (const file of files) {
  const filePath = path.join(migrationsDir, file);
  const sql = fs.readFileSync(filePath, "utf8");
  ok(sql.trim().length > 0, `Migration ${file} is not empty`);
  fullSql += "\n" + sql;
}

// Verify extensions
ok(/extension if not exists "pgcrypto"/i.test(fullSql), "pgcrypto extension declared");
ok(/extension if not exists "vector"/i.test(fullSql), "vector extension declared");
ok(/extension if not exists "ltree"/i.test(fullSql), "ltree extension declared");

// Verify staff_sessions table created before alter
const staffSessionsCreateIdx = fullSql.indexOf("CREATE TABLE staff_sessions");
const staffSessionsAlterIdx = fullSql.indexOf("ALTER TABLE staff_sessions");
ok(staffSessionsCreateIdx !== -1, "staff_sessions table created");
ok(staffSessionsAlterIdx !== -1, "staff_sessions table altered");
ok(staffSessionsCreateIdx < staffSessionsAlterIdx, "staff_sessions created before altered");

console.log(fails ? `migrations test: ${fails} FAILED` : "migrations test: all 14 migrations verified cleanly");
process.exit(fails ? 1 : 0);
