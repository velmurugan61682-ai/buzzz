/**
 * Production CRM APIs & Business Logic Test Suite.
 */
import { crmRoutes } from "./crm.js";

let fails = 0;
const ok = (c, m) => {
  if (!c) {
    console.log("  FAIL:", m);
    fails++;
  }
};

// In-memory mock database with workspace scoping and GiST-like appointment conflict prevention
const makeCrmMockDb = () => {
  const store = {
    contacts: [],
    companies: [],
    deals: [],
    tasks: [],
    appointments: [],
    audits: [],
  };

  return {
    listContacts: async (wsId, { limit = 50, offset = 0 } = {}) =>
      store.contacts.filter((c) => c.workspace_id === wsId && !c.archived).slice(offset, offset + limit),
    getContact: async (wsId, id) =>
      store.contacts.find((c) => c.workspace_id === wsId && c.id === id) || null,
    createContact: async (wsId, data) => {
      const c = { id: `cont_${Date.now()}_${Math.random()}`, workspace_id: wsId, ...data, created_at: new Date().toISOString() };
      store.contacts.push(c);
      return c;
    },
    updateContact: async (wsId, id, patch) => {
      const c = store.contacts.find((x) => x.workspace_id === wsId && x.id === id);
      if (!c) return null;
      Object.assign(c, patch, { updated_at: new Date().toISOString() });
      return c;
    },

    listCompanies: async (wsId, { limit = 50, offset = 0 } = {}) =>
      store.companies.filter((c) => c.workspace_id === wsId).slice(offset, offset + limit),
    getCompany: async (wsId, id) =>
      store.companies.find((c) => c.workspace_id === wsId && c.id === id) || null,
    createCompany: async (wsId, data) => {
      const comp = { id: `comp_${Date.now()}_${Math.random()}`, workspace_id: wsId, ...data, created_at: new Date().toISOString() };
      store.companies.push(comp);
      return comp;
    },
    updateCompany: async (wsId, id, patch) => {
      const comp = store.companies.find((x) => x.workspace_id === wsId && x.id === id);
      if (!comp) return null;
      Object.assign(comp, patch);
      return comp;
    },
    deleteCompany: async (wsId, id) => {
      store.companies = store.companies.filter((x) => !(x.workspace_id === wsId && x.id === id));
      return { ok: true };
    },

    listDeals: async (wsId, { limit = 50, offset = 0 } = {}) =>
      store.deals.filter((d) => d.workspace_id === wsId).slice(offset, offset + limit),
    getDeal: async (wsId, id) =>
      store.deals.find((d) => d.workspace_id === wsId && d.id === id) || null,
    createDeal: async (wsId, data) => {
      const d = { id: `deal_${Date.now()}_${Math.random()}`, workspace_id: wsId, ...data, created_at: new Date().toISOString() };
      store.deals.push(d);
      return d;
    },
    updateDeal: async (wsId, id, patch) => {
      const d = store.deals.find((x) => x.workspace_id === wsId && x.id === id);
      if (!d) return null;
      Object.assign(d, patch);
      return d;
    },
    deleteDeal: async (wsId, id) => {
      store.deals = store.deals.filter((x) => !(x.workspace_id === wsId && x.id === id));
      return { ok: true };
    },

    listTasks: async (wsId, { limit = 50, offset = 0, status = null } = {}) =>
      store.tasks
        .filter((t) => t.workspace_id === wsId && (!status || t.status === status))
        .slice(offset, offset + limit),
    getTask: async (wsId, id) =>
      store.tasks.find((t) => t.workspace_id === wsId && t.id === id) || null,
    createTask: async (wsId, data) => {
      const t = { id: `task_${Date.now()}_${Math.random()}`, workspace_id: wsId, ...data, created_at: new Date().toISOString() };
      store.tasks.push(t);
      return t;
    },
    updateTask: async (wsId, id, patch) => {
      const t = store.tasks.find((x) => x.workspace_id === wsId && x.id === id);
      if (!t) return null;
      Object.assign(t, patch);
      return t;
    },
    deleteTask: async (wsId, id) => {
      store.tasks = store.tasks.filter((x) => !(x.workspace_id === wsId && x.id === id));
      return { ok: true };
    },

    listAppointments: async (wsId, { limit = 50, offset = 0 } = {}) =>
      store.appointments.filter((a) => a.workspace_id === wsId).slice(offset, offset + limit),
    getAppointment: async (wsId, id) =>
      store.appointments.find((a) => a.workspace_id === wsId && a.id === id) || null,
    createAppointment: async (wsId, data) => {
      // Check for overlap
      const start = new Date(data.startsAt).getTime();
      const end = start + (data.durationMinutes || 30) * 60 * 1000;
      const conflict = store.appointments.find((a) => {
        if (a.workspace_id !== wsId || a.staff_id !== data.staffId || a.status === "cancelled") return false;
        const aStart = new Date(a.starts_at).getTime();
        const aEnd = aStart + (a.duration_minutes || 30) * 60 * 1000;
        return start < aEnd && end > aStart;
      });
      if (conflict) {
        const err = new Error("Staff member already has an overlapping appointment at that time.");
        err.code = "double_booking";
        throw err;
      }
      const appt = {
        id: `appt_${Date.now()}_${Math.random()}`,
        workspace_id: wsId,
        contact_id: data.contactId,
        staff_id: data.staffId,
        starts_at: data.startsAt,
        duration_minutes: data.durationMinutes,
        status: data.status || "scheduled",
        created_at: new Date().toISOString(),
      };
      store.appointments.push(appt);
      return appt;
    },
    updateAppointment: async (wsId, id, patch) => {
      const appt = store.appointments.find((x) => x.workspace_id === wsId && x.id === id);
      if (!appt) return null;
      Object.assign(appt, patch);
      return appt;
    },

    writeAudit: async (wsId, audit) => {
      store.audits.push({ id: `aud_${Date.now()}`, workspace_id: wsId, ...audit });
      return { ok: true };
    },
    listAuditEvents: async ({ workspaceId, limit = 50 } = {}) =>
      store.audits.filter((a) => a.workspace_id === workspaceId).slice(0, limit),
  };
};

const db = makeCrmMockDb();
const router = crmRoutes({ db });

const dispatch = async (method, path, { headers = {}, body = {}, query = {}, params = {}, workspace = { id: "ws_alpha", role: "admin" } } = {}) => {
  let matchedHandler = null;
  const pathParts = path.split("/").filter(Boolean);

  for (const layer of router.stack) {
    if (layer.route && layer.route.methods[method.toLowerCase()]) {
      const routeParts = layer.route.path.split("/").filter(Boolean);
      if (routeParts.length === pathParts.length) {
        let match = true;
        const extractedParams = { ...params };
        for (let i = 0; i < routeParts.length; i++) {
          if (routeParts[i].startsWith(":")) {
            extractedParams[routeParts[i].slice(1)] = pathParts[i];
          } else if (routeParts[i] !== pathParts[i]) {
            match = false;
            break;
          }
        }
        if (match) {
          matchedHandler = layer.route.stack[0].handle;
          params = extractedParams;
          break;
        }
      }
    }
  }

  if (!matchedHandler) {
    throw new Error(`No route found for ${method} ${path}`);
  }

  let statusCode = 200;
  let jsonBody = null;

  const req = {
    method,
    headers: { "x-workspace-id": workspace.id, ...headers },
    body,
    query,
    params,
    workspace,
    auth: { userId: "u1", workspaceId: workspace.id, role: workspace.role },
  };

  const res = {
    status: (code) => {
      statusCode = code;
      return res;
    },
    json: (data) => {
      jsonBody = data;
      return res;
    },
  };

  await matchedHandler(req, res, (err) => {
    if (err) {
      statusCode = err.status || 500;
      jsonBody = { code: err.code || "error", message: err.message };
    }
  });

  return { status: statusCode, body: jsonBody };
};

/* =========================================================================
   1. CONTACTS CRUD & SEARCH & 360
   ========================================================================= */
// Create Contact
const c1Res = await dispatch("POST", "/contacts", {
  body: { name: "Sarah Connor", email: "sarah@resistance.org", phone: "+1555123456" },
});
ok(c1Res.status === 201, "creates contact with 201");
const c1 = c1Res.body.contact;
ok(c1.name === "Sarah Connor", "stores contact name");
ok(c1.email === "sarah@resistance.org", "stores email normalised");

// List Contacts
const listCRes = await dispatch("GET", "/contacts");
ok(listCRes.status === 200, "lists contacts");
ok(listCRes.body.data.length === 1, "returns created contact");

// Get Contact
const getCRes = await dispatch("GET", `/contacts/${c1.id}`);
ok(getCRes.status === 200 && getCRes.body.contact.id === c1.id, "retrieves contact by id");

// Update Contact
const patchCRes = await dispatch("PATCH", `/contacts/${c1.id}`, { body: { company: "Cyberdyne Systems" } });
ok(patchCRes.status === 200 && patchCRes.body.contact.company === "Cyberdyne Systems", "updates contact company");

// Customer 360
const c360Res = await dispatch("GET", `/contacts/${c1.id}/360`);
ok(c360Res.status === 200 && c360Res.body.contact.id === c1.id, "returns customer 360 bundle");

// Bulk Tag
const bulkRes = await dispatch("POST", "/contacts/bulk", {
  body: { action: "tag", contactIds: [c1.id], payload: { tags: ["VIP", "High Priority"] } },
});
ok(bulkRes.status === 200 && bulkRes.body.processed === 1, "bulk tags contacts");

/* =========================================================================
   2. COMPANIES CRUD
   ========================================================================= */
const compRes = await dispatch("POST", "/companies", {
  body: { name: "Acme Medical Group", industry: "Healthcare", country: "US" },
});
ok(compRes.status === 201, "creates company");
const comp = compRes.body.company;
ok(comp.name === "Acme Medical Group", "company name matches");

const compListRes = await dispatch("GET", "/companies");
ok(compListRes.status === 200 && compListRes.body.data.length === 1, "lists companies");

/* =========================================================================
   3. DEALS CRUD
   ========================================================================= */
const dealRes = await dispatch("POST", "/deals", {
  body: { name: "Enterprise Suite Contract", valueMinor: 500000, currency: "USD", stage: "Proposal" },
});
ok(dealRes.status === 201, "creates deal");
const deal = dealRes.body.deal;
ok(deal.valueMinor === 500000, "stores monetary value in minor units");

const dealPatchRes = await dispatch("PATCH", `/deals/${deal.id}`, { body: { stage: "Won", probability: 100 } });
ok(dealPatchRes.status === 200 && dealPatchRes.body.deal.stage === "Won", "advances deal stage");

/* =========================================================================
   4. TASKS CRUD
   ========================================================================= */
const taskRes = await dispatch("POST", "/tasks", {
  body: { title: "Schedule onboarding call", priority: "high", contactId: c1.id },
});
ok(taskRes.status === 201, "creates task");
const task = taskRes.body.task;

const taskPatchRes = await dispatch("PATCH", `/tasks/${task.id}`, { body: { status: "completed" } });
ok(taskPatchRes.status === 200 && taskPatchRes.body.task.status === "completed", "completes task");

/* =========================================================================
   5. APPOINTMENTS & DOUBLE-BOOKING CONFLICT PREVENTION
   ========================================================================= */
const appt1Res = await dispatch("POST", "/appointments", {
  body: { staffId: "staff_dr_smith", startsAt: "2026-09-01T10:00:00.000Z", durationMinutes: 60, contactId: c1.id },
});
ok(appt1Res.status === 201, "books appointment");

// Attempt to book overlapping appointment with same staff member
const conflictRes = await dispatch("POST", "/appointments", {
  body: { staffId: "staff_dr_smith", startsAt: "2026-09-01T10:30:00.000Z", durationMinutes: 60, contactId: c1.id },
});
ok(conflictRes.status === 500 || conflictRes.status === 400, "prevents double-booking overlapping slot");
ok(conflictRes.body.code === "double_booking", "identifies double booking conflict");

/* =========================================================================
   6. GLOBAL SEARCH
   ========================================================================= */
const searchRes = await dispatch("GET", "/search", { query: { q: "Sarah" } });
ok(searchRes.status === 200, "search executes");
ok(searchRes.body.contacts.length >= 1, "finds contact in global search");

/* =========================================================================
   7. TENANT ISOLATION
   ========================================================================= */
// Workspace Beta cannot access Workspace Alpha's contact
const wsBetaRes = await dispatch("GET", `/contacts/${c1.id}`, {
  workspace: { id: "ws_beta_foreign", role: "admin" },
});
ok(wsBetaRes.status === 404, "cross-tenant contact access is blocked");

console.log(fails ? `crm tests: ${fails} FAILED` : "crm tests: all checks passed");
process.exit(fails ? 1 : 0);
