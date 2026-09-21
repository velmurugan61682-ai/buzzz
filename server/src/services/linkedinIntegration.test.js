import "dotenv/config";
import { connectDB, getLinkedInAccount, saveLinkedInAccount, deleteLinkedInAccount } from "../data/db.js";

async function runTests() {
  console.log("🧪 Starting LinkedIn Integration & Status Tests...\n");

  await connectDB();

  const testWs = "ws_test_linkedin_" + Date.now();

  try {
    // Test 1: Verify current live/workspace default LinkedIn account exists
    const liveAccount = await getLinkedInAccount("ws_default");
    console.log("Test 1: Check live LinkedIn account for ws_default:");
    if (!liveAccount) {
      throw new Error("Expected live LinkedIn account in MongoDB for ws_default, but none found.");
    }
    console.log(`  ✓ Found LinkedIn Account: ${liveAccount.name} (${liveAccount.linkedinId})`);
    console.log(`  ✓ Email: ${liveAccount.email}`);
    console.log(`  ✓ Expires At: ${liveAccount.expiresAt}`);
    const isExpired = new Date(liveAccount.expiresAt).getTime() <= Date.now();
    console.log(`  ✓ Is Valid & Not Expired: ${!isExpired}`);

    if (isExpired) {
      throw new Error("LinkedIn access token is expired!");
    }

    // Test 2: Status check via HTTP endpoint against running server on 5000
    console.log("\nTest 2: GET http://localhost:5000/api/linkedin/status");
    const statusRes = await fetch("http://localhost:5000/api/linkedin/status");
    const statusData = await statusRes.json();
    console.log("  Status Response:", statusData);
    if (!statusData.connected || statusData.name !== liveAccount.name) {
      throw new Error("HTTP status check failed to return connected LinkedIn profile");
    }
    console.log("  ✓ Status endpoint correctly returns connected: true with profile details");

    // Test 3: Status check via GET /api/v1/linkedin/status
    console.log("\nTest 3: GET http://localhost:5000/api/v1/linkedin/status");
    const v1StatusRes = await fetch("http://localhost:5000/api/v1/linkedin/status");
    const v1StatusData = await v1StatusRes.json();
    if (!v1StatusData.connected) {
      throw new Error("API v1 status endpoint failed");
    }
    console.log("  ✓ API v1 status endpoint correctly returns connected: true");

    // Test 4: Save & Retrieve on test workspace
    console.log("\nTest 4: Save & Retrieve on isolated test workspace");
    await saveLinkedInAccount({
      workspaceId: testWs,
      linkedinId: "test_sub_999",
      name: "Test Engineer",
      email: "test@example.com",
      accessToken: "mock_test_token",
      expiresAt: new Date(Date.now() + 86400000),
    });
    const retrieved = await getLinkedInAccount(testWs);
    if (!retrieved || retrieved.linkedinId !== "test_sub_999") {
      throw new Error("Failed to save and retrieve test LinkedIn account");
    }
    console.log("  ✓ Isolated workspace save & retrieve succeeded");

    // Cleanup test workspace
    await deleteLinkedInAccount(testWs);
    const cleaned = await getLinkedInAccount(testWs);
    if (cleaned && cleaned.linkedinId === "test_sub_999") {
      throw new Error("Failed to clean up test account");
    }
    console.log("  ✓ Cleaned up test account successfully");

    console.log("\n✅ ALL LINKEDIN INTEGRATION TESTS PASSED PERFECTLY!\n");
    process.exit(0);
  } catch (err) {
    console.error("❌ Test Failed:", err.message);
    process.exit(1);
  }
}

runTests();
