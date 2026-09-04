import fs from "node:fs";
import path from "node:path";

function replaceInFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, "utf-8");
  const updated = content
    .replace(/apps\/web/g, "client")
    .replace(/services\/api/g, "server")
    .replace(/services\/worker/g, "server");
  if (content !== updated) {
    fs.writeFileSync(filePath, updated, "utf-8");
    console.log(`Updated paths in ${filePath}`);
  }
}

function processDir(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const f of files) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) {
      if (f.name !== "node_modules" && f.name !== ".git") processDir(full);
    } else if (f.name.endsWith(".mjs") || f.name.endsWith(".js") || f.name.endsWith(".json")) {
      replaceInFile(full);
    }
  }
}

console.log("Updating script and test import paths to client/ and server/...");
processDir("scripts");
processDir("client");
processDir("server");
console.log("Path update complete!");
