import fs from "node:fs";
import path from "node:path";

function copyRecursiveSync(src, dest) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();
  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    fs.readdirSync(src).forEach((childItemName) => {
      if (childItemName === "node_modules" || childItemName === "dist" || childItemName === ".git") return;
      copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
    });
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

console.log("Syncing apps/web -> client...");
copyRecursiveSync("apps/web", "client");

console.log("Syncing services/api -> server...");
copyRecursiveSync("services/api", "server");

console.log("Sync complete!");
