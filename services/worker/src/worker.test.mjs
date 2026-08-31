/**
 * Background Worker & Job Execution Unit Tests.
 */
import { JobRunner, createDefaultWorker } from "./worker.js";
import { QueueManager } from "./queue.js";

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
    workflowRuns: new Map(),
    campaignRecipients: [],
    kbChunks: [],
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
    updateWorkflowRun: async (wsId, runId, patch) => {
      store.workflowRuns.set(runId, { workspaceId: wsId, runId, ...patch });
      return store.workflowRuns.get(runId);
    },
    recordCampaignRecipientStatus: async (wsId, campaignId, phone, status, msgId, err) => {
      store.campaignRecipients.push({ workspaceId: wsId, campaignId, phone, status, msgId, err });
      return { ok: true };
    },
    saveKbChunks: async (wsId, docId, chunks) => {
      store.kbChunks.push(...chunks.map((c) => ({ workspaceId: wsId, ...c })));
      return { ok: true };
    },
    store,
  };
};

const db = makeMockDb();
const worker = createDefaultWorker(db);

/* 1. Successful Email & Appointment Jobs */
const job1 = {
  id: "job_email_1",
  workspaceId: "ws_alpha",
  jobType: "email.send",
  payload: { to: "user@example.com", subject: "Welcome" },
};
const res1 = await worker.processJob(job1);
ok(res1.ok === true, "processes email job successfully");

/* 2. Workflow Wait Node Resumption Job */
const waitJob = {
  id: "job_wf_wait_1",
  workspaceId: "ws_alpha",
  jobType: "workflow.wait",
  payload: { runId: "run_99", resumeNodeId: "node_action_2", resumeState: { step: 2 } },
};
const waitRes = await worker.processJob(waitJob);
ok(waitRes.ok === true, "resumes workflow wait node");
ok(db.store.workflowRuns.get("run_99")?.currentNodeId === "node_action_2", "updates workflow run node ID");

/* 3. Campaign Recipient Batch Send Job */
const campaignJob = {
  id: "job_camp_1",
  workspaceId: "ws_alpha",
  jobType: "campaign.send",
  payload: {
    campaignId: "camp_100",
    recipients: [{ phone: "+1555123456", message: "Special Deal!" }],
  },
};
const campRes = await worker.processJob(campaignJob);
ok(campRes.ok === true, "processes campaign batch send");

/* 4. KB Ingestion Job */
const kbJob = {
  id: "job_kb_1",
  workspaceId: "ws_alpha",
  jobType: "kb.ingest",
  payload: { docId: "doc_101", title: "Product Manual", content: "BUZZZ is an AI CRM platform. ".repeat(30) },
};
const kbRes = await worker.processJob(kbJob);
ok(kbRes.ok === true, "processes KB document chunking");
ok(db.store.kbChunks.length > 0, "stores generated KB chunks");

/* 5. Queue Manager Enqueue & Drain */
const qm = new QueueManager();
const enqueued = await qm.enqueue("analytics.rollup", { period: "daily" }, { workspaceId: "ws_alpha" });
ok(enqueued.id.startsWith("job_"), "queue manager enqueues job with unique ID");

const pending = await qm.getPendingJobs("ws_alpha");
ok(pending.length === 1, "finds pending jobs in queue");

/* 6. Exponential Backoff & Dead-Letter Recording */
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
