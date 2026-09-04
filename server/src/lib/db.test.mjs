/** Data layer: tenant isolation, transactions, and the honest-null rule. */
import { createDb, DbError } from "./db.js";

let fails = 0;
const ok = (c, m) => {
  if (!c) {
    console.log("  FAIL:", m);
    fails++;
  }
};

/* a fake pg client that records what it was asked */
const makePool = (rows = [{}]) => {
  const log = [];
  return {
    log,
    query: async (text, params) => {
      log.push({ text: String(text).replace(/\s+/g, " ").trim(), params });
      return { rows };
    },
  };
};

/* ---- every tenant query carries its workspace ---- */
const pool = makePool([{ id: "c1" }]);
const db = createDb(pool);

const scoped = [
  ["listContacts", () => db.listContacts("ws1")],
  ["getContact", () => db.getContact("ws1", "c1")],
  ["createContact", () => db.createContact("ws1", { name: "A" })],
  ["listCompanies", () => db.listCompanies("ws1")],
  ["getCompany", () => db.getCompany("ws1", "comp1")],
  ["createCompany", () => db.createCompany("ws1", { name: "Acme Corp" })],
  ["listDeals", () => db.listDeals("ws1")],
  ["getDeal", () => db.getDeal("ws1", "d1")],
  ["createDeal", () => db.createDeal("ws1", { name: "Big Deal" })],
  ["listTasks", () => db.listTasks("ws1")],
  ["getTask", () => db.getTask("ws1", "t1")],
  ["createTask", () => db.createTask("ws1", { title: "Follow up" })],
  ["listAppointments", () => db.listAppointments("ws1")],
  ["getAppointment", () => db.getAppointment("ws1", "a1")],
  ["createAppointment", () => db.createAppointment("ws1", { startsAt: new Date().toISOString(), durationMinutes: 30 })],
  ["listConversations", () => db.listConversations("ws1")],
  ["getConversation", () => db.getConversation("ws1", "conv1")],
  ["listMessages", () => db.listMessages("ws1", "conv1")],
  ["listAgents", () => db.listAgents("ws1")],
  ["getAgent", () => db.getAgent("ws1", "ag1")],
  ["listWorkflows", () => db.listWorkflows("ws1")],
  ["getWorkflow", () => db.getWorkflow("ws1", "wf1")],
  ["listCampaigns", () => db.listCampaigns("ws1")],
  ["getCampaign", () => db.getCampaign("ws1", "camp1")],
  ["listKbSources", () => db.listKbSources("ws1")],
  ["getKbSource", () => db.getKbSource("ws1", "kb1")],
  ["listApprovals", () => db.listApprovals("ws1")],
  ["getApproval", () => db.getApproval("ws1", "appr1")],
  ["getGoogleConnection", () => db.getGoogleConnection("ws1")],
  ["setWorkspaceStatus", () => db.setWorkspaceStatus("ws1", "suspended")],
];

for (const [name, fn] of scoped) {
  pool.log.length = 0;
  await fn();
  const q = pool.log[0];
  /* a read or update filters on workspace_id; an insert sets it as a column;
     the workspaces table itself keys on id. All three are scoped. */
  const scopedQuery =
    /workspace_id = \$1/.test(q.text) ||
    /INSERT INTO \w+ \([^)]*workspace_id/.test(q.text) ||
    /UPDATE workspaces SET .* WHERE id = \$1/.test(q.text);
  ok(scopedQuery, `${name} is scoped to a single tenant`);
  ok(q.params[0] === "ws1", `${name} passes the workspace as the first parameter`);
}

/* ---- and refuses to run without one ---- */
for (const [name, fn] of [
  ["listContacts", () => db.listContacts(null)],
  ["getContact", () => db.getContact(undefined, "c1")],
  ["listCompanies", () => db.listCompanies("")],
  ["listDeals", () => db.listDeals(null)],
  ["listTasks", () => db.listTasks(undefined)],
  ["listAgents", () => db.listAgents("")],
  ["listWorkflows", () => db.listWorkflows(null)],
  ["listCampaigns", () => db.listCampaigns(undefined)],
  ["getGoogleConnection", () => db.getGoogleConnection(null)],
]) {
  try {
    await fn();
    ok(false, `${name} should refuse a missing workspace`);
  } catch (e) {
    ok(e.code === "missing_scope", `${name} refuses a query with no tenant scope`);
  }
}

/* ---- transactions ---- */
const txPool = makePool([{ id: "ws9" }]);
const txDb = createDb(txPool);
await txDb.createWorkspace({ name: "Acme", ownerId: "u1" });
const texts = txPool.log.map((l) => l.text);
ok(texts[0] === "BEGIN", "workspace creation opens a transaction");
ok(texts[texts.length - 1] === "COMMIT", "and commits when it succeeds");
ok(texts.some((t) => /INSERT INTO workspace_members/.test(t)), "the owner membership is created with the workspace");

const failPool = {
  log: [],
  query: async (text) => {
    failPool.log.push(String(text).trim().split(" ")[0]);
    if (/INSERT INTO workspace_members/.test(text)) throw new Error("boom");
    return { rows: [{ id: "ws9" }] };
  },
};
const failDb = createDb(failPool);
try {
  await failDb.createWorkspace({ name: "Acme", ownerId: "u1" });
  ok(false, "a failed step should throw");
} catch {
  ok(failPool.log.includes("ROLLBACK"), "a half created workspace is rolled back, never left behind");
}

/* ---- metrics: measured or null, never a filled in zero ---- */
const mPool = makePool([
  {
    workspaces: 3,
    activeUsers7d: 11,
    signups7d: 2,
    messagesToday: 40,
    aiActions24h: 9,
    approvalsPending: 1,
    workflowFailures24h: 0,
    integrationFailures24h: 0,
    apiErrors24h: 0,
  },
]);
const m = await createDb(mPool).platformMetrics();
ok(m.workspaces === 3, "counted metrics come back as numbers");
ok(m.workflowFailures24h === 0, "a real zero is preserved");
ok(m.mrr === null && m.churn === null, "billing figures are null, not zero, while billing is not wired up");
ok(m.storageBytes === null, "unmeasured storage is null rather than invented");

/* ---- audit is append only in this layer ---- */
const api = createDb(makePool());
ok(typeof api.writeAudit === "function", "audit can be written");
ok(
  api.updateAudit === undefined && api.deleteAudit === undefined,
  "there is no way to update or delete an audit event from the data layer"
);

/* ---- credentials never travel further than they must ---- */
const uPool = makePool([{ id: "u1", email: "a@b.com", name: "A", emailVerified: true, status: "active" }]);
const users = await createDb(uPool).listUsers({});
ok(!/password_hash/.test(uPool.log[0].text), "the user listing does not select password hashes");

/* ---- update guard ---- */
try {
  await db.updateContact("ws1", "c1", {});
  ok(false, "an empty patch should be refused");
} catch (e) {
  ok(e.code === "empty_patch", "an empty update is refused rather than issuing a broken query");
}

console.log(fails ? `data layer: ${fails} FAILED` : "data layer: all checks passed");
process.exit(fails ? 1 : 0);
