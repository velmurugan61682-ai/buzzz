/**
 * CRM Domain Routes & Business Logic.
 *
 * Implements production endpoints for Contacts, Companies, Deals, Tasks,
 * Appointments, Customer 360, and Global Search with strict workspace scoping.
 */

import { Router } from "express";
import { PERMISSIONS } from "../lib/permissions.js";

export function crmRoutes({ db }) {
  const r = Router();

  const handle = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      next(e);
    }
  };

  const getWorkspaceId = (req) => {
    const wsId = req.workspace?.id || req.auth?.workspaceId || req.headers["x-workspace-id"];
    if (!wsId) {
      const err = new Error("Workspace context is required");
      err.status = 400;
      throw err;
    }
    return wsId;
  };

  /* =========================================================================
     CONTACTS
     ========================================================================= */

  r.get("/contacts", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const offset = parseInt(req.query.offset || "0", 10);
    const contacts = await db.listContacts(wsId, { limit, offset });
    res.json({
      data: contacts,
      pagination: { limit, offset, count: contacts.length },
    });
  }));

  r.post("/contacts", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const body = req.body || {};
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      return res.status(400).json({ code: "invalid_input", message: "Contact name is required." });
    }

    const contact = await db.createContact(wsId, {
      name: body.name.trim(),
      email: body.email ? String(body.email).trim().toLowerCase() : null,
      phone: body.phone ? String(body.phone).trim() : null,
      company: body.company ? String(body.company).trim() : null,
      source: body.source || "web",
      status: body.status || "New",
      ownerId: body.ownerId || req.auth?.userId || null,
    });

    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "contact.created",
      targetType: "contact",
      targetId: contact.id,
      detail: { name: contact.name, email: contact.email },
    });

    res.status(201).json({ contact });
  }));

  r.get("/contacts/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const contact = await db.getContact(wsId, req.params.id);
    if (!contact) {
      return res.status(404).json({ code: "not_found", message: "Contact not found." });
    }
    res.json({ contact });
  }));

  r.patch("/contacts/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const allowed = ["name", "email", "phone", "company", "status", "source", "tags", "custom_fields"];
    const patch = {};
    for (const key of allowed) {
      if (key in req.body) patch[key] = req.body[key];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ code: "empty_patch", message: "No valid fields provided to update." });
    }
    const updated = await db.updateContact(wsId, req.params.id, patch);
    if (!updated) {
      return res.status(404).json({ code: "not_found", message: "Contact not found." });
    }

    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "contact.updated",
      targetType: "contact",
      targetId: req.params.id,
      detail: { fields: Object.keys(patch) },
    });

    res.json({ contact: updated });
  }));

  r.delete("/contacts/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const updated = await db.updateContact(wsId, req.params.id, { archived: true });
    if (!updated) {
      return res.status(404).json({ code: "not_found", message: "Contact not found." });
    }
    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "contact.archived",
      targetType: "contact",
      targetId: req.params.id,
    });
    res.json({ ok: true, id: req.params.id });
  }));

  // Customer 360 Timeline
  r.get("/contacts/:id/360", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const contact = await db.getContact(wsId, req.params.id);
    if (!contact) {
      return res.status(404).json({ code: "not_found", message: "Contact not found." });
    }

    const [tasks, deals, appointments, audit] = await Promise.all([
      db.listTasks(wsId, { limit: 20 }),
      db.listDeals(wsId, { limit: 20 }),
      db.listAppointments(wsId, { limit: 20 }),
      db.listAuditEvents({ workspaceId: wsId, limit: 50 }),
    ]);

    const contactTasks = tasks.filter((t) => t.contact_id === contact.id);
    const contactDeals = deals.filter((d) => d.contact_id === contact.id);
    const contactAppointments = appointments.filter((a) => a.contact_id === contact.id);

    res.json({
      contact,
      deals: contactDeals,
      tasks: contactTasks,
      appointments: contactAppointments,
      timeline: audit.filter((e) => e.target_id === contact.id),
    });
  }));

  // Bulk Operations
  r.post("/contacts/bulk", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const { action, contactIds, payload } = req.body || {};
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({ code: "invalid_input", message: "contactIds array is required." });
    }

    let processed = 0;
    for (const id of contactIds) {
      if (action === "archive") {
        await db.updateContact(wsId, id, { archived: true });
        processed++;
      } else if (action === "tag" && Array.isArray(payload?.tags)) {
        await db.updateContact(wsId, id, { tags: payload.tags });
        processed++;
      } else if (action === "assign" && payload?.ownerId) {
        await db.updateContact(wsId, id, { owner_id: payload.ownerId });
        processed++;
      }
    }

    res.json({ ok: true, processed, total: contactIds.length });
  }));

  // Import Contacts
  r.post("/contacts/import", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const { contacts } = req.body || {};
    if (!Array.isArray(contacts)) {
      return res.status(400).json({ code: "invalid_input", message: "contacts array is required." });
    }

    let imported = 0;
    let failed = 0;
    const errors = [];

    for (const c of contacts) {
      try {
        if (!c.name) throw new Error("Missing name");
        await db.createContact(wsId, {
          name: String(c.name).trim(),
          email: c.email || null,
          phone: c.phone || null,
          company: c.company || null,
          source: c.source || "import",
          status: c.status || "New",
        });
        imported++;
      } catch (err) {
        failed++;
        errors.push({ contact: c, error: err.message });
      }
    }

    res.json({
      summary: {
        total: contacts.length,
        imported,
        failed,
        errors: errors.slice(0, 10),
      },
    });
  }));

  /* =========================================================================
     COMPANIES
     ========================================================================= */

  r.get("/companies", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const offset = parseInt(req.query.offset || "0", 10);
    const companies = await db.listCompanies(wsId, { limit, offset });
    res.json({ data: companies, pagination: { limit, offset, count: companies.length } });
  }));

  r.post("/companies", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const body = req.body || {};
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      return res.status(400).json({ code: "invalid_input", message: "Company name is required." });
    }
    const company = await db.createCompany(wsId, {
      name: body.name.trim(),
      parentId: body.parentId || null,
      country: body.country || null,
      domain: body.domain || null,
      industry: body.industry || null,
    });
    res.status(201).json({ company });
  }));

  r.get("/companies/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const company = await db.getCompany(wsId, req.params.id);
    if (!company) return res.status(404).json({ code: "not_found", message: "Company not found." });
    res.json({ company });
  }));

  r.patch("/companies/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const patch = {};
    for (const key of ["name", "country", "domain", "industry", "parent_id"]) {
      if (key in req.body) patch[key] = req.body[key];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ code: "empty_patch", message: "No valid fields provided to update." });
    }
    const updated = await db.updateCompany(wsId, req.params.id, patch);
    if (!updated) return res.status(404).json({ code: "not_found", message: "Company not found." });
    res.json({ company: updated });
  }));

  r.delete("/companies/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    await db.deleteCompany(wsId, req.params.id);
    res.json({ ok: true, id: req.params.id });
  }));

  /* =========================================================================
     DEALS & PIPELINES
     ========================================================================= */

  r.get("/deals", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const offset = parseInt(req.query.offset || "0", 10);
    const deals = await db.listDeals(wsId, { limit, offset });
    res.json({ data: deals, pagination: { limit, offset, count: deals.length } });
  }));

  r.post("/deals", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const body = req.body || {};
    if (!body.name || typeof body.name !== "string") {
      return res.status(400).json({ code: "invalid_input", message: "Deal name is required." });
    }
    const deal = await db.createDeal(wsId, {
      name: body.name.trim(),
      contactId: body.contactId || null,
      companyId: body.companyId || null,
      valueMinor: body.valueMinor || 0,
      currency: body.currency || "USD",
      stage: body.stage || "Lead",
      probability: body.probability ?? 20,
      ownerId: body.ownerId || req.auth?.userId || null,
    });
    res.status(201).json({ deal });
  }));

  r.get("/deals/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const deal = await db.getDeal(wsId, req.params.id);
    if (!deal) return res.status(404).json({ code: "not_found", message: "Deal not found." });
    res.json({ deal });
  }));

  r.patch("/deals/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const patch = {};
    for (const key of ["name", "value_minor", "currency", "stage", "probability", "owner_id"]) {
      if (key in req.body) patch[key] = req.body[key];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ code: "empty_patch", message: "No valid fields provided to update." });
    }
    const updated = await db.updateDeal(wsId, req.params.id, patch);
    if (!updated) return res.status(404).json({ code: "not_found", message: "Deal not found." });
    res.json({ deal: updated });
  }));

  r.delete("/deals/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    await db.deleteDeal(wsId, req.params.id);
    res.json({ ok: true, id: req.params.id });
  }));

  /* =========================================================================
     TASKS
     ========================================================================= */

  r.get("/tasks", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const offset = parseInt(req.query.offset || "0", 10);
    const status = req.query.status || null;
    const tasks = await db.listTasks(wsId, { limit, offset, status });
    res.json({ data: tasks, pagination: { limit, offset, count: tasks.length } });
  }));

  r.post("/tasks", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const body = req.body || {};
    if (!body.title || typeof body.title !== "string") {
      return res.status(400).json({ code: "invalid_input", message: "Task title is required." });
    }
    const task = await db.createTask(wsId, {
      title: body.title.trim(),
      description: body.description || null,
      status: body.status || "pending",
      priority: body.priority || "medium",
      dueDate: body.dueDate || null,
      assigneeId: body.assigneeId || null,
      contactId: body.contactId || null,
      companyId: body.companyId || null,
      dealId: body.dealId || null,
      createdBy: req.auth?.userId || null,
    });
    res.status(201).json({ task });
  }));

  r.get("/tasks/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const task = await db.getTask(wsId, req.params.id);
    if (!task) return res.status(404).json({ code: "not_found", message: "Task not found." });
    res.json({ task });
  }));

  r.patch("/tasks/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const patch = {};
    for (const key of ["title", "description", "status", "priority", "due_date", "assignee_id", "completed_at"]) {
      if (key in req.body) patch[key] = req.body[key];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ code: "empty_patch", message: "No valid fields provided to update." });
    }
    const updated = await db.updateTask(wsId, req.params.id, patch);
    if (!updated) return res.status(404).json({ code: "not_found", message: "Task not found." });
    res.json({ task: updated });
  }));

  r.delete("/tasks/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    await db.deleteTask(wsId, req.params.id);
    res.json({ ok: true, id: req.params.id });
  }));

  /* =========================================================================
     APPOINTMENTS
     ========================================================================= */

  r.get("/appointments", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const offset = parseInt(req.query.offset || "0", 10);
    const appointments = await db.listAppointments(wsId, { limit, offset });
    res.json({ data: appointments, pagination: { limit, offset, count: appointments.length } });
  }));

  r.post("/appointments", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const body = req.body || {};
    if (!body.startsAt || !body.durationMinutes) {
      return res.status(400).json({ code: "invalid_input", message: "startsAt and durationMinutes are required." });
    }
    const appt = await db.createAppointment(wsId, {
      contactId: body.contactId || null,
      staffId: body.staffId || null,
      serviceId: body.serviceId || null,
      locationId: body.locationId || null,
      startsAt: body.startsAt,
      durationMinutes: parseInt(body.durationMinutes, 10),
      status: body.status || "scheduled",
      source: body.source || "api",
    });
    res.status(201).json({ appointment: appt });
  }));

  r.get("/appointments/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const appt = await db.getAppointment(wsId, req.params.id);
    if (!appt) return res.status(404).json({ code: "not_found", message: "Appointment not found." });
    res.json({ appointment: appt });
  }));

  r.patch("/appointments/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const patch = {};
    for (const key of ["starts_at", "duration_minutes", "status", "room", "staff_id"]) {
      if (key in req.body) patch[key] = req.body[key];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ code: "empty_patch", message: "No valid fields provided to update." });
    }
    const updated = await db.updateAppointment(wsId, req.params.id, patch);
    if (!updated) return res.status(404).json({ code: "not_found", message: "Appointment not found." });
    res.json({ appointment: updated });
  }));

  /* =========================================================================
     GLOBAL SEARCH
     ========================================================================= */

  r.get("/search", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const query = String(req.query.q || "").trim().toLowerCase();
    if (!query) {
      return res.json({ contacts: [], companies: [], deals: [], tasks: [] });
    }

    const [contacts, companies, deals, tasks] = await Promise.all([
      db.listContacts(wsId, { limit: 100 }),
      db.listCompanies(wsId, { limit: 100 }),
      db.listDeals(wsId, { limit: 100 }),
      db.listTasks(wsId, { limit: 100 }),
    ]);

    const matchedContacts = contacts.filter((c) =>
      c.name?.toLowerCase().includes(query) || c.email?.toLowerCase().includes(query) || c.phone?.includes(query)
    );
    const matchedCompanies = companies.filter((c) => c.name?.toLowerCase().includes(query) || c.domain?.toLowerCase().includes(query));
    const matchedDeals = deals.filter((d) => d.name?.toLowerCase().includes(query));
    const matchedTasks = tasks.filter((t) => t.title?.toLowerCase().includes(query) || t.description?.toLowerCase().includes(query));

    res.json({
      contacts: matchedContacts.slice(0, 10),
      companies: matchedCompanies.slice(0, 10),
      deals: matchedDeals.slice(0, 10),
      tasks: matchedTasks.slice(0, 10),
    });
  }));

  return r;
}
