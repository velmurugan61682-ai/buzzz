/**
 * Production MongoDB Connection & Lifecycle Module.
 *
 * Provides a resilient, single-pool Mongoose connection manager with
 * graceful shutdown, health reporting, and strict secret protection.
 */

import mongoose from "mongoose";

let isConnecting = false;
let isListenersAttached = false;

/**
 * Connect to MongoDB Atlas / Server using Mongoose.
 * Reuses existing connection if already established or in progress.
 */
export async function connectMongoDB(uri = process.env.MONGODB_URI) {
  if (!uri) {
    return { ok: false, status: "disconnected", reason: "MONGODB_URI not configured" };
  }

  // Ready states: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  if (mongoose.connection.readyState === 1) {
    return { ok: true, status: "connected" };
  }

  if (mongoose.connection.readyState === 2 || isConnecting) {
    return { ok: true, status: "connecting" };
  }

  try {
    isConnecting = true;

    // Attach process listeners once for graceful teardown
    if (!isListenersAttached) {
      const gracefulTeardown = async () => {
        try {
          if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
          }
        } catch {
          // ignore error on exit
        }
      };

      process.once("SIGINT", gracefulTeardown);
      process.once("SIGTERM", gracefulTeardown);
      isListenersAttached = true;
    }

    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
    });

    isConnecting = false;
    return { ok: true, status: "connected" };
  } catch (err) {
    isConnecting = false;
    return { ok: false, status: "disconnected", error: err.message };
  }
}

/**
 * Gracefully disconnect MongoDB connection.
 */
export async function disconnectMongoDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  return { ok: true, status: "disconnected" };
}

/**
 * Returns safe health status string: "connected" or "disconnected".
 * Guaranteed to NEVER leak URI, credentials, or password.
 */
export function getMongoDBStatus() {
  return mongoose.connection.readyState === 1 ? "connected" : "disconnected";
}
