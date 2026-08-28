/**
 * Background Worker & Job Execution Unit Tests.
 */
import { JobRunner, createDefaultWorker } from "./worker.js";

let fails = 0;
const ok = (c, m) => {
  if (!c) {
    console.log("  FAIL:", m);
    fails++;
  }
};

const makeMockDb = () => {
  const store = {
    failures: [],
    notifications: [],
    audits: [],
  };

  return {
    recordJobFailure: async (wsId, job) => {
      store.failures.push({ workspace_id: wsId, ...job });
      return { ok: true };
    },
    recordNotification: async (wsId, n) => {
      store.notifications.push({ workspace_id: wsId, ...n });
      return { ok: true };
    },
    writeAudit: async (wsId, a) => {
      store.audits.push({ workspace_id: wsId, ...a });
      return { ok: true };
    },
  };
};

const db = makeMockDb();
const worker = createDefaultWorker(db);

/* 1. Successful Job Processing */
const job1 = {
  id: "job_email_1",
  workspaceId: "ws_alpha",
  jobType: "email.send",
  payload: { to: "user@example.com", subject: "Welcome" },
};
const res1 = await worker.processJob(job1);
ok(res1.ok === true, "processes email job successfully");

/* 2. Exponential Backoff on Failure */
worker.registerHandler("test.flaky", async () => {
  throw new Error("Temporary provider timeout");
});

const job2 = {
  id: "job_flaky_1",
  workspaceId: "ws_alpha",
  jobType: "test.flaky",
  payload: {},
  attempts: 0,
};
const res2 = await worker.processJob(job2);
ok(res2.ok === false && res2.retryAfterMs === 2000, "calculates exponential backoff delay for retry");

/* 3. Dead-Letter Recording on Max Retries */
const job3 = {
  id: "job_fatal_1",
  workspaceId: "ws_alpha",
  jobType: "test.flaky",
  payload: {},
  attempts: 2, // Exceeds maxRetries = 3
};
const res3 = await worker.processJob(job3);
ok(res3.ok === false && res3.failedPermanently === true, "records fatal failure in dead-letter table");

console.log(fails ? `worker: ${fails} FAILED` : "worker: all checks passed");
process.exit(fails ? 1 : 0);
