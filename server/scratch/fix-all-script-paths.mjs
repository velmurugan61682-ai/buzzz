import fs from "node:fs";
import path from "node:path";

function updatePathsInFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, "utf-8");
  
  // Replace string array paths like "apps", "web" -> "client"
  let updated = content
    .replace(/"apps",\s*"web"/g, '"client"')
    .replace(/'apps',\s*'web'/g, "'client'")
    .replace(/"services",\s*"api"/g, '"server"')
    .replace(/'services',\s*'api'/g, "'server'")
    .replace(/apps\/web/g, "client")
    .replace(/services\/api/g, "server");

  if (content !== updated) {
    fs.writeFileSync(filePath, updated, "utf-8");
    console.log(`Updated paths in ${filePath}`);
  }
}

const dir = "scripts";
const files = fs.readdirSync(dir);
for (const f of files) {
  const full = path.join(dir, f);
  if (fs.statSync(full).isFile()) {
    updatePathsInFile(full);
  }
}

console.log("Updated all script paths to client/ and server/!");
