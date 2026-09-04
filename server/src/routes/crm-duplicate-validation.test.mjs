import { strict as assert } from "node:assert";
import express from "express";
import http from "node:http";
import { createDb, DuplicateError } from "../lib/db.js";
import { createAuthMiddleware } from "../middleware/authenticate.js";
import { tenantScope } from "../middleware/tenant-scope.js";
import { errorHandler } from "../middleware/error-handler.js";
import { crmRoutes } from "./crm.js";

/* Mock In-Memory SQL Engine supporting contacts table and UNIQUE constraint checks */
class MockSqlEngine {
  constructor() {
    this.tables = {
      contacts: [
        {
          id: "ct_101",
          workspace_id: "11111111-1111-1111-1111-111111111111",
          name: "Alice Smith",
          email: "alice@acme.com",
          phone: "+15550001",
          phone_norm: "+15550001",
          archived: false,
        },
        {
          id: "ct_102",
          workspace_id: "11111111-1111-1111-1111-111111111111",
          name: "Bob Jones",
          email: "bob@acme.com",
          phone: "+15550002",
          phone_norm: "+15550002",
          archived: false,
        },
      ],
    };
  }

  async query(text, params = []) {
    const trimmed = text.trim();

    // SELECT query for pre-checks or contact lookup
    if (trimmed.startsWith("SELECT")) {
      if (trimmed.includes("FROM contacts")) {
        let rows = [...this.tables.contacts];
        if (params[0]) {
          rows = rows.filter((r) => r.workspace_id === params[0]);
        }
        if (trimmed.includes("lower(email) = lower($2)")) {
          const targetEmail = params[1]?.toLowerCase();
          rows = rows.filter((r) => r.email?.toLowerCase() === targetEmail);
        }
        if (trimmed.includes("id != $3")) {
          rows = rows.filter((r) => r.id !== params[2]);
        }
        if (trimmed.includes("id = $2")) {
          rows = rows.filter((r) => r.id === params[1]);
        }
        return { rows };
      }
    }

    // UPDATE query for contact
    if (trimmed.startsWith("UPDATE contacts")) {
      const wsId = params[0];
      const id = params[1];
      const contact = this.tables.contacts.find((r) => r.workspace_id === wsId && r.id === id);

      if (!contact) return { rows: [] };

      // Extract updated fields from query text or params
      if (trimmed.includes("email = $3")) {
        const newEmail = params[2];
        
        // Simulate race condition bypass check: if force_race param is passed or another row matches, trigger 23505
        const duplicate = this.tables.contacts.find(
          (r) => r.workspace_id === wsId && r.id !== id && r.email?.toLowerCase() === newEmail?.toLowerCase()
        );
        if (duplicate) {
          const err = new Error(`Key (workspace_id, lower(email))=(${wsId}, ${newEmail}) already exists.`);
          err.code = "23505";
          err.constraint = "unique_contacts_workspace_email";
          throw err;
        }
        contact.email = newEmail;
      }

      if (trimmed.includes("name = $3")) {
        contact.name = params[2];
      }

      return { rows: [contact] };
    }

    return { rows: [] };
  }
}

async function runDuplicateValidationTests() {
  console.log("=== Edit Endpoints Duplicate-Value Validation Suite ===");

  const sqlEngine = new MockSqlEngine();
  const db = createDb(sqlEngine);

  const authMiddleware = (req, res, next) => {
    req.user = { id: "usr_100", email: "admin@acme.com" };
    req.auth = { userId: "usr_100", workspaceId: req.headers["x-workspace-id"] };
    next();
  };

  const app = express();
  app.use(express.json());
  app.use("/api/v1", authMiddleware, tenantScope, crmRoutes({ db }));
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  const validToken = "valid_token";
  const wsId = "11111111-1111-1111-1111-111111111111";

  try {
    // 1. Normal edit succeeding
    console.log("Test 1: Normal edit to unique email returns 200 OK...");
    const res1 = await fetch(`${baseUrl}/contacts/ct_102`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
        "x-workspace-id": wsId,
      },
      body: JSON.stringify({ email: "bob.updated@acme.com" }),
    });

    const body1 = await res1.json();
    assert.equal(res1.status, 200, `Expected 200 OK, got ${res1.status}`);
    assert.equal(body1.contact.email, "bob.updated@acme.com", "Email should be updated");
    console.log("   -> PASSED: 200 OK with updated body.");

    // 2. Duplicate edit returning 409 Conflict with structured payload
    console.log("Test 2: Pre-check duplicate edit returns 409 Conflict...");
    const res2 = await fetch(`${baseUrl}/contacts/ct_102`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
        "x-workspace-id": wsId,
      },
      body: JSON.stringify({ email: "alice@acme.com" }),
    });

    const body2 = await res2.json();
    assert.equal(res2.status, 409, `Expected 409 Conflict, got ${res2.status}`);
    assert.equal(body2.code, "duplicate_value", `Expected code 'duplicate_value', got '${body2.code}'`);
    assert.equal(body2.field, "email", `Expected field 'email', got '${body2.field}'`);
    assert(body2.message.includes("alice@acme.com"), "Message should mention duplicate email");
    console.log("   -> PASSED:", JSON.stringify(body2));

    // 3. Race condition bypassing pre-check into SQL 23505 unique constraint returns 409 Conflict
    console.log("Test 3: Concurrent race condition triggering 23505 constraint returns 409 Conflict (not 500)...");
    
    // Test direct DB execution simulating 23505 constraint catch
    let raceErr = null;
    try {
      // Direct call to updateContact bypassing precheck to test 23505 catch
      await db.updateContact(wsId, "ct_102", { email: "alice@acme.com" });
    } catch (err) {
      raceErr = err;
    }

    assert(raceErr, "Should throw error on duplicate");
    assert.equal(raceErr.status, 409, `Expected status 409, got ${raceErr.status}`);
    assert.equal(raceErr.code, "duplicate_value", `Expected code 'duplicate_value', got '${raceErr.code}'`);
    assert.equal(raceErr.field, "email", `Expected field 'email', got '${raceErr.field}'`);
    console.log("   -> PASSED: 23505 constraint caught and converted to 409 DuplicateError.");

  } finally {
    server.close();
  }

  console.log("crm duplicate validation test: ALL CHECKS PASSED");
}

runDuplicateValidationTests().catch((err) => {
  console.error("crm duplicate validation test FAILED:", err);
  process.exit(1);
});
