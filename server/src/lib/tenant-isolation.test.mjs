/** Multi-tenant isolation, tested as an attacker rather than as a user.
 *  Every one of these is an attempt by workspace A to touch workspace B. */
import { createDb, DbError } from "./db.js";
import { canAccessWorkspace, requireStaff } from "./auth.js";

let fails = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL:", m); fails++; } };

/* a fake pool that records the SQL and refuses to return other tenants' rows */
const makePool = (rows = [{ id: "x" }]) => {
  const log = [];
  return { log, query: async (text, params) => { log.push({ text: String(text).replace(/\s+/g, " ").trim(), params }); return { rows }; } };
};

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

/* ---- every tenant read carries its own workspace, and only its own ---- */
const pool = makePool();
const db = createDb(pool);
const reads = [
  ["contacts", () => db.listContacts(A)],
  ["one contact", () => db.getContact(A, "c-from-B")],
  ["conversations", () => db.listConversations(A)],
  ["agents", () => db.listAgents(A)],
  ["workflows", () => db.listWorkflows(A)],
  ["appointment", () => db.getAppointment(A, "appt-from-B")],
  ["google connection", () => db.getGoogleConnection(A)],
];
for (const [name, fn] of reads) {
  pool.log.length = 0;
  await fn();
  const q = pool.log[0];
  ok(q.params[0] === A, `${name}: scoped to the caller's workspace`);
  ok(!JSON.stringify(q.params).includes(B), `${name}: the other workspace never appears in the query`);
  ok(/workspace_id = \$1/.test(q.text), `${name}: the filter is in the SQL, not applied afterwards in JavaScript`);
}

/* ---- an attacker supplying another workspace id gets that workspace only if
       they are a member: the id alone must not be authority ---- */
const memberOfA = [{ userId: "u1", workspaceId: A, role: "admin" }];
const session = { user: { id: "u1" } };
ok(canAccessWorkspace(session, A, memberOfA).ok === true, "a member reaches their own workspace");
ok(canAccessWorkspace(session, B, memberOfA).ok === false, "IDOR: passing another workspace id is refused");
ok(canAccessWorkspace(session, B, memberOfA).reason === "not_a_member", "and the refusal names the reason");

/* ---- a forged membership row for a different user must not help ---- */
const forged = [{ userId: "someone-else", workspaceId: B, role: "owner" }];
ok(canAccessWorkspace(session, B, forged).ok === false,
   "a membership belonging to another user does not grant access");

/* ---- staff are not implicitly tenants ---- */
const staff = { user: { id: "s1" }, staff: { role: "superadmin" } };
ok(canAccessWorkspace(staff, A, []).ok === false, "even a superadmin has no implicit access to customer data");
const granted = { ...staff, supportGrant: { workspaceId: A, expiresAt: new Date(Date.now() + 6e5).toISOString(), readOnly: true } };
ok(canAccessWorkspace(granted, A, []).readOnly === true, "a support grant is read only by default");
ok(canAccessWorkspace(granted, B, []).ok === false, "a grant for one workspace does not open another");
const expired = { ...staff, supportGrant: { workspaceId: A, expiresAt: new Date(Date.now() - 1).toISOString() } };
ok(canAccessWorkspace(expired, A, []).ok === false, "an expired grant is dead");

/* ---- a missing scope must throw rather than query every tenant ---- */
for (const [name, fn] of [
  ["listContacts", () => db.listContacts(undefined)],
  ["listAgents", () => db.listAgents(null)],
  ["getGoogleConnection", () => db.getGoogleConnection("")],
]) {
  try { await fn(); ok(false, `${name}: an unscoped query must not be allowed`); }
  catch (e) { ok(e.code === "missing_scope", `${name}: an unscoped query throws instead of returning every tenant`); }
}

/* ---- injection: an id is a parameter, never string concatenation ---- */
pool.log.length = 0;
await db.getContact(A, "'; DROP TABLE contacts; --");
const q = pool.log[0];
ok(!q.text.includes("DROP"), "a malicious id never reaches the SQL text");
ok(q.params.includes("'; DROP TABLE contacts; --"), "it is passed as a bound parameter instead");

/* ---- mass assignment: an update may only touch supplied columns ---- */
pool.log.length = 0;
await db.updateContact(A, "c1", { name: "New" });
ok(/SET name = \$3/.test(pool.log[0].text), "an update writes only the fields given");
ok(pool.log[0].params[0] === A, "and stays inside the workspace");

/* ---- the staff role ladder ---- */
ok(requireStaff({ staff: { role: "support" } }, "superadmin").ok === false, "support cannot act as superadmin");
ok(requireStaff({ user: {} }, "support").ok === false, "a customer session is not staff");

console.log(fails ? `tenant isolation: ${fails} FAILED` : "tenant isolation: all 32 checks passed");
process.exit(fails ? 1 : 0);
