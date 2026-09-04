import fs from "node:fs";
import path from "node:path";

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git" || entry.name === "web" || entry.name === "api") continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

if (fs.existsSync("apps/web")) {
  console.log("Copying apps/web -> client...");
  copyDir("apps/web", "client");
}

if (fs.existsSync("services/api")) {
  console.log("Copying services/api -> server...");
  copyDir("services/api", "server");
}

console.log("Copy done. Removing apps and services...");
try { fs.rmSync("apps", { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync("services", { recursive: true, force: true }); } catch (e) {}

console.log("Checking client and server existence:");
console.log("client exists:", fs.existsSync("client/src/App.jsx"));
console.log("server exists:", fs.existsSync("server/src/index.js"));
