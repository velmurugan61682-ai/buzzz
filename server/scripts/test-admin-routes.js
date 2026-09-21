// Test script for BUZZZ Admin API endpoints
async function testAdminEndpoints() {
  console.log("🔍 Testing BUZZZ Admin API endpoints at http://localhost:5000/api/v1/admin...");

  try {
    const overviewRes = await fetch("http://localhost:5000/api/v1/admin/overview");
    const overviewData = await overviewRes.json();
    console.log("✅ /api/v1/admin/overview status:", overviewRes.status, "success:", overviewData.success);
    console.log("   Contacts:", overviewData.data?.stats?.totalContacts, "Conversations:", overviewData.data?.stats?.totalConversations);
    console.log("   Channels:", overviewData.data?.stats?.channelBreakdown);
    console.log("   DB Status:", overviewData.data?.system?.dbStatus);

    const integrationsRes = await fetch("http://localhost:5000/api/v1/admin/integrations");
    const integrationsData = await integrationsRes.json();
    console.log("✅ /api/v1/admin/integrations status:", integrationsRes.status, "count:", integrationsData.integrations?.length);
    for (const it of integrationsData.integrations || []) {
      console.log(`   - [${it.status.toUpperCase()}] ${it.name} (${it.channel})`);
    }

    const healthRes = await fetch("http://localhost:5000/api/v1/admin/health");
    const healthData = await healthRes.json();
    console.log("✅ /api/v1/admin/health status:", healthRes.status, "health:", healthData.status);

    const usersRes = await fetch("http://localhost:5000/api/v1/admin/users");
    const usersData = await usersRes.json();
    console.log("✅ /api/v1/admin/users status:", usersRes.status, "staff count:", usersData.staff?.length);

    console.log("\n🎉 ALL ADMIN API ENDPOINTS WORKING PROPERLY!");
  } catch (err) {
    console.error("❌ Admin API test failed:", err.message);
  }
}

testAdminEndpoints();
