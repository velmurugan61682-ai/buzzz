import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import {
  verifyGoWhatsConnection,
  sendWhatsAppMessage,
  fetchGoWhatsMessages,
  syncGoWhatsContacts,
  updateGoWhatsContact,
} from "./gowhats.js";

async function testGoWhatsIntegration() {
  console.log("🧪 Testing GoWhats (bot.gowhats.in) Integration & 3 Granted Scopes...\n");

  let passed = 0;
  let failed = 0;

  function assertEqual(actual, expected, testName) {
    if (actual === expected) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      console.error(`     Expected: ${expected}`);
      console.error(`     Actual:   ${actual}`);
      failed++;
    }
  }

  function assertTruthy(actual, testName) {
    if (Boolean(actual)) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      console.error(`     Expected truthy value, got: ${actual}`);
      failed++;
    }
  }

  // 1. Connection Health Verification
  console.log("--- 1. Connection Health & Usage Tracker Test ---");
  const health = await verifyGoWhatsConnection();
  assertEqual(health.connected, true, "verifyGoWhatsConnection connects successfully to bot.gowhats.in");

  // 2. Scope: Read Messages
  console.log("\n--- 2. Scope: Read Messages Test ---");
  const readRes = await fetchGoWhatsMessages({ phoneNumber: "919047484484" });
  assertEqual(readRes.success, true, "fetchGoWhatsMessages returns HTTP 200 OK");
  assertTruthy(Array.isArray(readRes.messages), "fetchGoWhatsMessages returns array of messages");

  // 3. Scope: Send Messages
  console.log("\n--- 3. Scope: Send Messages Test ---");
  const sendRes = await sendWhatsAppMessage({ to: "919047484484", text: "Automated test reply from BUZZZ" });
  assertTruthy(sendRes.gowhatsMessageId !== undefined, "sendWhatsAppMessage returns gowhatsMessageId");
  assertEqual(sendRes.status, "sent", "Outbound WhatsApp message status is 'sent'");

  // 4. Scope: Read Contacts
  console.log("\n--- 4. Scope: Read Contacts Test ---");
  const contactRes = await syncGoWhatsContacts({ workspaceId: "test_ws" });
  assertEqual(contactRes.success, true, "syncGoWhatsContacts returns HTTP 200 OK");
  assertTruthy(typeof contactRes.syncedCount === "number", "syncGoWhatsContacts returns numeric syncedCount");

  // 5. Scope: Write Contacts
  console.log("\n--- 5. Scope: Write Contacts Test ---");
  const writeRes = await updateGoWhatsContact({ phone: "919597586785", updateData: { alias: "Vasu" } });
  assertEqual(writeRes.success, true, "updateGoWhatsContact returns success");

  console.log(`\n=======================================================`);
  console.log(`Test Results: ${passed} passed, ${failed} failed`);
  console.log(`=======================================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

testGoWhatsIntegration();
