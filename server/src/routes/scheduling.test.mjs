/**
 * Scheduling & Appointment Routes Integration Tests.
 */
import { schedulingRoutes } from "./scheduling.js";

let fails = 0;
const ok = (c, m) => {
  if (!c) {
    console.log("  FAIL:", m);
    fails++;
  }
};

const makeMockDb = () => {
  const store = {
    locations: [],
    services: [],
    schedules: [],
    appointments: [],
    contacts: [],
    audits: [],
  };

  return {
    listLocations: async (wsId) => store.locations.filter((l) => l.workspace_id === wsId),
    getLocation: async (wsId, id) => store.locations.find((l) => l.workspace_id === wsId && l.id === id) || null,
    createLocation: async (wsId, loc) => {
      const l = { id: `loc_${Date.now()}_${Math.random()}`, workspace_id: wsId, ...loc };
      store.locations.push(l);
      return l;
    },
    updateLocation: async (wsId, id, patch) => {
      const l = store.locations.find((x) => x.workspace_id === wsId && x.id === id);
      if (!l) return null;
      Object.assign(l, patch);
      return l;
    },

    listServices: async (wsId, { category } = {}) =>
      store.services.filter((s) => s.workspace_id === wsId && (!category || s.category === category)),
    getService: async (wsId, id) => store.services.find((s) => s.workspace_id === wsId && s.id === id) || null,
    createService: async (wsId, svc) => {
      const s = { id: `svc_${Date.now()}_${Math.random()}`, workspace_id: wsId, ...svc };
      store.services.push(s);
      return s;
    },
    updateService: async (wsId, id, patch) => {
      const s = store.services.find((x) => x.workspace_id === wsId && x.id === id);
      if (!s) return null;
      Object.assign(s, patch);
      return s;
    },

    listStaffSchedules: async (wsId, staffId) =>
      store.schedules.filter((s) => s.workspace_id === wsId && s.staff_id === staffId),
    setStaffSchedule: async (wsId, sched) => {
      const s = { id: `sch_${Date.now()}`, workspace_id: wsId, ...sched };
      store.schedules.push(s);
      return s;
    },
    getStaffAppointmentsForDate: async (wsId, staffId, start, end) =>
      store.appointments.filter((a) => a.workspace_id === wsId && a.staff_id === staffId && a.status !== "cancelled"),

    listAppointments: async (wsId, { limit = 50 } = {}) =>
      store.appointments.filter((a) => a.workspace_id === wsId).slice(0, limit),
    getAppointment: async (wsId, id) =>
      store.appointments.find((a) => a.workspace_id === wsId && a.id === id) || null,
    createAppointment: async (wsId, a) => {
      const appt = { id: `appt_${Date.now()}_${Math.random()}`, workspace_id: wsId, ...a, created_at: new Date().toISOString() };
      store.appointments.push(appt);
      return appt;
    },
    updateAppointment: async (wsId, id, patch) => {
      const a = store.appointments.find((x) => x.workspace_id === wsId && x.id === id);
      if (!a) return null;
      Object.assign(a, patch);
      return a;
    },

    findContactByPhoneOrEmail: async (wsId, { phone, email }) =>
      store.contacts.find((c) => c.workspace_id === wsId && ((phone && c.phone === phone) || (email && c.email === email))) || null,
    createContact: async (wsId, data) => {
      const c = { id: `cont_${Date.now()}`, workspace_id: wsId, ...data };
      store.contacts.push(c);
      return c;
    },

    writeAudit: async (wsId, e) => {
      store.audits.push({ id: `aud_${Date.now()}`, workspace_id: wsId, ...e });
      return { ok: true };
    },
  };
};

const db = makeMockDb();
const broadcasts = [];
const router = schedulingRoutes({
  db,
  broadcast: (wsId, event, data) => broadcasts.push({ wsId, event, data }),
});

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
   1. LOCATIONS CRUD
   ========================================================================= */
const locRes = await dispatch("POST", "/locations", {
  body: { name: "Anna Nagar Clinic", timezone: "Asia/Kolkata", address: "10 Main Rd, Anna Nagar" },
});
ok(locRes.status === 201, "creates location");
const loc = locRes.body.location;

const locListRes = await dispatch("GET", "/locations");
ok(locListRes.status === 200 && locListRes.body.data.length === 1, "lists locations");

/* =========================================================================
   2. SERVICES CRUD
   ========================================================================= */
const svcRes = await dispatch("POST", "/services", {
  body: { name: "Dental Checkup", category: "Dental", durationMinutes: 45, priceMinor: 5000 },
});
ok(svcRes.status === 201, "creates service");
const svc = svcRes.body.service;

const svcListRes = await dispatch("GET", "/services", { query: { category: "Dental" } });
ok(svcListRes.status === 200 && svcListRes.body.data.length === 1, "filters services by category");

/* =========================================================================
   3. STAFF SCHEDULES & AVAILABILITY
   ========================================================================= */
const schedRes = await dispatch("POST", "/staff/dr_priya/schedules", {
  body: { dayOfWeek: 1, startTime: "09:00", endTime: "13:00" },
});
ok(schedRes.status === 201, "sets staff schedule");

const availRes = await dispatch("GET", "/availability", {
  query: { date: "2026-09-07", staffId: "dr_priya", serviceId: svc.id },
});
ok(availRes.status === 200, "availability calculated");
ok(availRes.body.availableSlots.length > 0, "generates available slots for staff member");

/* =========================================================================
   4. APPOINTMENT LIFECYCLE (BOOK -> CONFIRM -> CHECK-IN -> COMPLETE)
   ========================================================================= */
const apptRes = await dispatch("POST", "/appointments", {
  body: {
    staffId: "dr_priya",
    serviceId: svc.id,
    locationId: loc.id,
    startsAt: "2026-09-07T09:00:00.000Z",
    durationMinutes: 45,
  },
});
ok(apptRes.status === 201, "books appointment");
const appt = apptRes.body.appointment;

// Check-in
const checkInRes = await dispatch("POST", `/appointments/${appt.id}/check-in`);
ok(checkInRes.status === 200 && checkInRes.body.appointment.status === "checked_in", "checks in appointment");

// Complete
const compRes = await dispatch("POST", `/appointments/${appt.id}/complete`);
ok(compRes.status === 200 && compRes.body.appointment.status === "completed", "completes appointment");

// Reschedule test
const reschedRes = await dispatch("POST", `/appointments/${appt.id}/reschedule`, {
  body: { startsAt: "2026-09-07T11:00:00.000Z" },
});
ok(reschedRes.status === 200 && reschedRes.body.appointment.status === "rescheduled", "reschedules appointment");

/* =========================================================================
   5. PUBLIC BOOKING PORTAL
   ========================================================================= */
const pubBookingRes = await dispatch("POST", "/public/booking/ws_alpha", {
  body: {
    name: "John Doe",
    phone: "+1555000111",
    serviceId: svc.id,
    startsAt: "2026-09-07T10:00:00.000Z",
  },
});
ok(pubBookingRes.status === 201, "public online booking succeeds");
ok(pubBookingRes.body.contact.phone === "+1555000111", "creates contact from public booking");

/* =========================================================================
   6. TENANT ISOLATION
   ========================================================================= */
const foreignLocRes = await dispatch("GET", `/locations/${loc.id}`, {
  workspace: { id: "ws_foreign_beta", role: "admin" },
});
ok(foreignLocRes.status === 404, "cross-tenant location lookup blocked");

console.log(fails ? `scheduling routes: ${fails} FAILED` : "scheduling routes: all checks passed");
process.exit(fails ? 1 : 0);
