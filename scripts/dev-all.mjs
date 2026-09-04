import { spawn } from "child_process";
import process from "process";

const isWindows = process.platform === "win32";
const npmCmd = isWindows ? "npm.cmd" : "npm";

console.log("\x1b[36m%s\x1b[0m", "🚀 Starting BUZZZ Client & Server concurrently...");

// Start Backend Server
const apiProcess = spawn(npmCmd, ["run", "dev", "--workspace", "server"], {
  stdio: "inherit",
  shell: isWindows,
  env: { ...process.env },
});

// Start Frontend Client
const webProcess = spawn(npmCmd, ["run", "dev", "--workspace", "client"], {
  stdio: "inherit",
  shell: isWindows,
  env: { ...process.env },
});

function cleanup() {
  console.log("\n\x1b[33m%s\x1b[0m", "Stopping all processes...");
  if (apiProcess && !apiProcess.killed) apiProcess.kill();
  if (webProcess && !webProcess.killed) webProcess.kill();
  process.exit();
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("exit", cleanup);
