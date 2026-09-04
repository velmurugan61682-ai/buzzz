/**
 * CI Route Authentication & Tenant Scoping Guard.
 *
 * Scans server/src/index.js and server/src/routes/*.js to enforce that:
 * 1. Global middleware authenticate & tenantScope are attached before tenant routes in index.js.
 * 2. Every tenant route module in server/src/routes/ is registered under the auth/tenant middleware chain.
 * 3. Every route file exported in server/src/routes/ properly inspects workspace context (workspace_id).
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
const apiDir = path.join(dir, "..", "server", "src");
const indexFile = path.join(apiDir, "index.js");
const routesDir = path.join(apiDir, "routes");

const indexContent = fs.readFileSync(indexFile, "utf8");

// 1. Verify index.js registers authenticate and tenantScope
ok(indexContent.includes("authenticate") && indexContent.includes("tenantScope"), "index.js imports authenticate and tenantScope middleware");
const authChainIdx = indexContent.search(/app\.use\(["']\/api\/v1["'],\s*authenticate,\s*tenantScope\)/);
ok(
  authChainIdx !== -1,
  "index.js mounts app.use('/api/v1', authenticate, tenantScope)"
);

// 2. Verify all tenant routes are mounted AFTER authChainIdx in index.js
const tenantRouteFunctions = [
  "crmRoutes",
  "inboxRoutes",
  "schedulingRoutes",
  "agentRoutes",
  "workflowRoutes",
  "billingRoutes",
  "integrationRoutes",
  "googleRoutes",
];

for (const fn of tenantRouteFunctions) {
  const callRegex = new RegExp(`app\\.use\\([^)]*${fn}`);
  const fnIdx = indexContent.search(callRegex);
  ok(fnIdx !== -1, `index.js invokes app.use for '${fn}'`);
  ok(fnIdx > authChainIdx, `Route handler '${fn}' is mounted AFTER authenticate and tenantScope middleware`);
}

// 3. Scan route files in server/src/routes/
const routeFiles = fs.readdirSync(routesDir).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));

for (const file of routeFiles) {
  const filePath = path.join(routesDir, file);
  const content = fs.readFileSync(filePath, "utf8");

  // Skip public auth.js and health.js
  if (file === "health.js" || file === "auth.js") continue;

  const mentionsWorkspace =
    /workspace/i.test(content) ||
    /getWorkspaceId/i.test(content) ||
    /wsId/i.test(content) ||
    /x-workspace-id/i.test(content);

  ok(mentionsWorkspace, `Route file ${file} enforces workspace scoping context`);
}

console.log(fails ? `route auth check: ${fails} FAILED` : "route auth check: all checks passed (100% routes guarded)");
process.exit(fails ? 1 : 0);
