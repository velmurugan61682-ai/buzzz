/**
 * MongoDB + Mongoose Integration Tests.
 */
import { connectMongoDB, disconnectMongoDB, getMongoDBStatus } from "./mongodb.js";

let fails = 0;
const ok = (c, m) => {
  if (!c) {
    console.log("  FAIL:", m);
    fails++;
  }
};

/* 1. Initial Status */
const initialStatus = getMongoDBStatus();
ok(initialStatus === "connected" || initialStatus === "disconnected", "status is either connected or disconnected");

/* 2. Disconnected without URI */
const noUriRes = await connectMongoDB("");
ok(noUriRes.ok === false && noUriRes.status === "disconnected", "handles missing URI safely");

/* 3. Connection Failure Graceful Handling */
const badRes = await connectMongoDB("mongodb://invalid-host-name-that-does-not-exist:27017/test?serverSelectionTimeoutMS=100");
ok(badRes.ok === false && badRes.status === "disconnected", "gracefully handles connection failure without crashing");

/* 4. Health Status format verification */
const healthStatus = getMongoDBStatus();
ok(healthStatus === "connected" || healthStatus === "disconnected", "health status returns clean string without credentials");
ok(!healthStatus.includes("mongodb://") && !healthStatus.includes("@"), "never exposes credentials in health status");

/* 5. Graceful Disconnect */
const discRes = await disconnectMongoDB();
ok(discRes.ok === true && discRes.status === "disconnected", "gracefully disconnects");

console.log(fails ? `mongodb: ${fails} FAILED` : "mongodb: all checks passed");
process.exit(fails ? 1 : 0);
