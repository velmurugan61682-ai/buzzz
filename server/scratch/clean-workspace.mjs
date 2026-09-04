import fs from "node:fs";
import path from "node:path";

function cleanCopyFolder(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git" || entry.name === "web" || entry.name === "api") {
      continue;
    }

    if (entry.isDirectory()) {
      cleanCopyFolder(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log("Cleaning and copying apps/web -> client...");
cleanCopyFolder("apps/web", "client");

console.log("Cleaning and copying services/api -> server...");
cleanCopyFolder("services/api", "server");

console.log("Removing apps and services directories...");
try {
  fs.rmSync("apps", { recursive: true, force: true });
} catch (e) { console.error("Error removing apps:", e.message); }

try {
  fs.rmSync("services", { recursive: true, force: true });
} catch (e) { console.error("Error removing services:", e.message); }

console.log("Workspace cleanup complete!");
