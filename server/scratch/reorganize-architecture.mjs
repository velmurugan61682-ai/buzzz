import fs from "node:fs";
import path from "node:path";

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const file of fs.readdirSync(src)) {
      if (file === "node_modules" || file === "dist" || file === ".git" || file === "web" || file === "api") continue;
      copyRecursive(path.join(src, file), path.join(dest, file));
    }
  } else if (stats.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

console.log("1. Copying database/ into server/database/...");
copyRecursive("database", "server/database");

console.log("2. Ensuring apps/web -> client...");
if (fs.existsSync("apps/web")) {
  copyRecursive("apps/web", "client");
}

console.log("3. Ensuring services/api -> server...");
if (fs.existsSync("services/api")) {
  copyRecursive("services/api", "server");
}

console.log("4. Safely removing duplicate apps and services folders...");
try {
  fs.rmSync("apps", { recursive: true, force: true });
} catch (e) {}

try {
  fs.rmSync("services", { recursive: true, force: true });
} catch (e) {}

console.log("Architecture reorganization script complete!");
