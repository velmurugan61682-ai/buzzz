/**
 * Dependency Drift Audit Script.
 *
 * Scans JavaScript source files across workspace packages (server, server, client)
 * and asserts that every imported non-relative module is explicitly declared as a dependency in
 * the package.json manifest.
 */

import fs from "node:fs";
import path from "node:path";

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) {
    console.error("  FAIL:", msg);
    fails++;
  }
};

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "dns", "domain", "events", "fs", "fs/promises", "http", "http2", "https",
  "module", "net", "os", "path", "process", "punycode", "querystring", "readline",
  "repl", "stream", "string_decoder", "sys", "timers", "tls", "tty", "url", "util",
  "v8", "vm", "wasi", "worker_threads", "zlib",
]);

function getImportsFromFile(filePath) {
  const code = fs.readFileSync(filePath, "utf8");
  const imports = new Set();
  // Match import ... from "specifier" or import("specifier") or require("specifier")
  const regex = /(?:import\s+[\s\S]*?\s+from\s+["']([^"']+)["'])|(?:import\s*\(["']([^"']+)["']\))|(?:require\s*\(["']([^"']+)["']\))/g;
  let match;
  while ((match = regex.exec(code)) !== null) {
    const spec = match[1] || match[2] || match[3];
    if (spec && !spec.includes(" ") && !spec.includes("+") && !spec.includes(":")) {
      imports.add(spec);
    }
  }
  return Array.from(imports);
}

function scanDir(dir, fileList = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== ".git") {
      scanDir(fullPath, fileList);
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".jsx") || entry.name.endsWith(".mjs"))) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

function checkWorkspace(workspacePath, pkgJsonPath) {
  if (!fs.existsSync(pkgJsonPath)) {
    ok(false, `Missing package.json at ${pkgJsonPath}`);
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  const declaredDeps = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ]);

  const files = scanDir(workspacePath);
  for (const file of files) {
    const specs = getImportsFromFile(file);
    for (const spec of specs) {
      if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) {
        continue;
      }
      const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (NODE_BUILTINS.has(pkgName)) {
        continue;
      }
      const isDeclared = declaredDeps.has(pkgName);
      ok(
        isDeclared,
        `Undeclared dependency '${pkgName}' imported in ${path.relative(process.cwd(), file)} (declared in ${path.basename(pkgJsonPath)}: ${isDeclared})`
      );
    }
  }
}

console.log("=== Dependency Drift Audit ===");
checkWorkspace("server/src", "server/package.json");
checkWorkspace("server/src", "server/package.json");
checkWorkspace("client/src", "client/package.json");

console.log(fails ? `dependency audit: ${fails} undeclared dependencies found` : "dependency audit: all imports matched declared package dependencies");
process.exit(fails ? 1 : 0);
