import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
  const convId = "conv_yt_CodeWithKaran";
  const res = await fetch(`http://localhost:5000/api/conversations/${encodeURIComponent(convId)}/messages`);
  const data = await res.json();
  console.log(`Status for ${convId}: ${res.status}`);
  console.log("Messages returned:", JSON.stringify(data, null, 2));
}

run();
