/** The API server boots, mounts the implemented routes, and guards them.
 *  No database is required: these paths must reject before they query. */
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/nonexistent";
process.env.PORT = "4177";
process.env.LOG_LEVEL = "silent";

const quiet = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...a) => (String(chunk).startsWith("{\"level\"") ? true : quiet(chunk, ...a));

await import("../server/src/index.js");
await new Promise((r) => setTimeout(r, 500));

let fails = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL:", m); fails++; } };
const hit = async (path, opts = {}) => {
  const res = await fetch("http://127.0.0.1:4177" + path,
    { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  let body = {}; try { body = await res.json(); } catch {}
  return { status: res.status, code: body.code || "" };
};

ok((await hit("/health")).status === 200, "health check is public and answers");

/* implemented routes exist and refuse anonymous callers */
const session = await hit("/api/v1/auth/session");
ok(session.status === 401 && session.code === "not_authenticated", "session requires a cookie");
const admin = await hit("/api/v1/admin/overview");
ok(admin.status === 401, "admin overview refuses an anonymous caller");
const grant = await hit("/api/v1/admin/support-grants", { method: "POST", body: JSON.stringify({ workspaceId: "w1", reason: "x" }) });
ok(grant.status === 401, "support grants refuse an anonymous caller");
const suspend = await hit("/api/v1/admin/workspaces/w1/suspend", { method: "POST", body: JSON.stringify({}) });
ok(suspend.status === 401, "suspension refuses an anonymous caller");

/* validation happens before the database is touched */
const login = await hit("/api/v1/auth/login", { method: "POST", body: JSON.stringify({}) });
ok(login.status === 400 && login.code === "invalid_email", "login validates input before querying");

/* unported domains still fail loudly rather than pretending to work */
const contacts = await hit("/api/v1/contacts");
ok([401, 501].includes(contacts.status), "an unported domain fails loudly");

/* implemented routes are not shadowed by the 501 handler */
ok(session.code !== "not_implemented", "auth is implemented, not a stub");
ok(admin.code !== "not_implemented", "admin is implemented, not a stub");

console.log(fails ? ("api routes: " + fails + " FAILED") : "api routes: all checks passed");

/* ---- security controls added in the hardening pass ---- */
const origin = async (o) => {
  const res = await fetch("http://127.0.0.1:4177/api/v1/auth/session", { headers: { origin: o } });
  return { status: res.status, allow: res.headers.get("access-control-allow-origin") };
};
const good = await origin("https://buzzzbuzzz.com");
const evil = await origin("https://evil.example.com");
ok(good.allow === "https://buzzzbuzzz.com", "an allowed origin is echoed back explicitly");
ok(evil.allow !== "*", "the API never answers with a wildcard origin");
ok(evil.allow === null || evil.allow === undefined, "an unknown origin gets no CORS grant");

/* brute force protection on login */
let limited = false;
for (let i = 0; i < 26; i++) {
  const r = await hit("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ email: "a@b.com", password: "wrong" }) });
  if (r.status === 429) { limited = true; break; }
}
ok(limited, "repeated login attempts are rate limited");

const health2 = await hit("/health");
ok(health2.status === 200, "the health check is not caught by the API limiter");

console.log(fails ? ("api security: " + fails + " FAILED") : "api security: all checks passed");
process.exit(fails ? 1 : 0);
