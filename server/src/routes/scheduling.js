/**
 * Industry-Agnostic Scheduling & Appointment Routes.
 *
 * Provides REST endpoints for Locations, Services, Staff Schedules,
 * Slot Availability, Booking, Lifecycle Transitions, and Public Booking.
 */

import { Router } from "express";
import { getAvailableSlots } from "../lib/scheduling.js";

export function schedulingRoutes({ db, broadcast = () => {} }) {
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
     LOCATIONS
     ========================================================================= */

  r.get("/locations", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const locations = await db.listLocations(wsId);
    res.json({ data: locations, count: locations.length });
  }));

  r.post("/locations", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const { name, timezone = "UTC", address, phone, operatingHours } = req.body || {};
    if (!name) return res.status(400).json({ code: "invalid_input", message: "Location name is required." });

    const loc = await db.createLocation(wsId, { name, timezone, address, phone, operatingHours });
    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "location.created",
      targetType: "location",
      targetId: loc.id,
      detail: { name, timezone },
    });
    res.status(201).json({ location: loc });
  }));

  r.get("/locations/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const loc = await db.getLocation(wsId, req.params.id);
    if (!loc) return res.status(404).json({ code: "not_found", message: "Location not found." });
    res.json({ location: loc });
  }));

  r.patch("/locations/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const updated = await db.updateLocation(wsId, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ code: "not_found", message: "Location not found." });
    res.json({ location: updated });
  }));

  /* =========================================================================
     SERVICES
     ========================================================================= */

  r.get("/services", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const category = req.query.category || null;
    const services = await db.listServices(wsId, { category });
    res.json({ data: services, count: services.length });
  }));

  r.post("/services", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const { name, category, description, durationMinutes, bufferBeforeMinutes, bufferAfterMinutes, priceMinor, currency, capacity, isVirtual } = req.body || {};
    if (!name) return res.status(400).json({ code: "invalid_input", message: "Service name is required." });

    const svc = await db.createService(wsId, {
      name,
      category,
      description,
      durationMinutes,
      bufferBeforeMinutes,
      bufferAfterMinutes,
      priceMinor,
      currency,
      capacity,
      isVirtual,
    });
    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "service.created",
      targetType: "service",
      targetId: svc.id,
      detail: { name, durationMinutes },
    });
    res.status(201).json({ service: svc });
  }));

  r.get("/services/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const svc = await db.getService(wsId, req.params.id);
    if (!svc) return res.status(404).json({ code: "not_found", message: "Service not found." });
    res.json({ service: svc });
  }));

  r.patch("/services/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const updated = await db.updateService(wsId, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ code: "not_found", message: "Service not found." });
    res.json({ service: updated });
  }));

  /* =========================================================================
     STAFF SCHEDULES
     ========================================================================= */

  r.get("/staff/:staffId/schedules", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const schedules = await db.listStaffSchedules(wsId, req.params.staffId);
    res.json({ data: schedules });
  }));

  r.post("/staff/:staffId/schedules", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const { dayOfWeek, startTime, endTime } = req.body || {};
    if (dayOfWeek === undefined || !startTime || !endTime) {
      return res.status(400).json({ code: "invalid_input", message: "dayOfWeek, startTime, and endTime are required." });
    }
    const schedule = await db.setStaffSchedule(wsId, {
      staffId: req.params.staffId,
      dayOfWeek: Number(dayOfWeek),
      startTime,
      endTime,
    });
    res.status(201).json({ schedule });
  }));

  /* =========================================================================
     AVAILABILITY ENGINE
     ========================================================================= */

  r.get("/availability", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const { date, serviceId, staffId, locationId, timezone } = req.query || {};
    if (!date) return res.status(400).json({ code: "invalid_input", message: "Date parameter (YYYY-MM-DD) is required." });

    const slots = await getAvailableSlots(db, {
      workspaceId: wsId,
      locationId: locationId || null,
      serviceId: serviceId || null,
      staffId: staffId || null,
      date,
      timezone: timezone || "UTC",
    });

    res.json(slots);
  }));

  /* =========================================================================
     APPOINTMENTS & LIFECYCLE
     ========================================================================= */

  r.get("/appointments", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);
    const offset = parseInt(req.query.offset || "0", 10);
    const appts = await db.listAppointments(wsId, { limit, offset });
    res.json({ data: appts, count: appts.length });
  }));

  r.post("/appointments", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const { contactId, staffId, serviceId, locationId, startsAt, durationMinutes = 30, notes, isVirtual } = req.body || {};

    if (!startsAt) {
      return res.status(400).json({ code: "invalid_input", message: "startsAt timestamp is required." });
    }

    const appt = await db.createAppointment(wsId, {
      contactId: contactId || null,
      staffId: staffId || null,
      serviceId: serviceId || null,
      locationId: locationId || null,
      startsAt,
      durationMinutes,
      status: "confirmed",
      source: "api",
      isVirtual: !!isVirtual,
    });

    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "appointment.created",
      targetType: "appointment",
      targetId: appt.id,
      detail: { staffId, startsAt, durationMinutes },
    });

    broadcast(wsId, "appointment.created", { appointment: appt });
    res.status(201).json({ appointment: appt });
  }));

  r.get("/appointments/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const appt = await db.getAppointment(wsId, req.params.id);
    if (!appt) return res.status(404).json({ code: "not_found", message: "Appointment not found." });
    res.json({ appointment: appt });
  }));

  r.post("/appointments/:id/confirm", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const appt = await db.updateAppointment(wsId, req.params.id, { status: "confirmed" });
    if (!appt) return res.status(404).json({ code: "not_found", message: "Appointment not found." });
    await db.writeAudit(wsId, { actorType: "user", actorId: req.auth?.userId, action: "appointment.confirmed", targetType: "appointment", targetId: appt.id });
    res.json({ appointment: appt });
  }));

  r.post("/appointments/:id/check-in", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const appt = await db.updateAppointment(wsId, req.params.id, { status: "checked_in", check_in_at: new Date().toISOString() });
    if (!appt) return res.status(404).json({ code: "not_found", message: "Appointment not found." });
    await db.writeAudit(wsId, { actorType: "user", actorId: req.auth?.userId, action: "appointment.checked_in", targetType: "appointment", targetId: appt.id });
    res.json({ appointment: appt });
  }));

  r.post("/appointments/:id/complete", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const appt = await db.updateAppointment(wsId, req.params.id, { status: "completed" });
    if (!appt) return res.status(404).json({ code: "not_found", message: "Appointment not found." });
    await db.writeAudit(wsId, { actorType: "user", actorId: req.auth?.userId, action: "appointment.completed", targetType: "appointment", targetId: appt.id });
    res.json({ appointment: appt });
  }));

  r.post("/appointments/:id/no-show", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const appt = await db.updateAppointment(wsId, req.params.id, { status: "no_show" });
    if (!appt) return res.status(404).json({ code: "not_found", message: "Appointment not found." });
    await db.writeAudit(wsId, { actorType: "user", actorId: req.auth?.userId, action: "appointment.no_show", targetType: "appointment", targetId: appt.id });
    res.json({ appointment: appt });
  }));

  r.post("/appointments/:id/cancel", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const appt = await db.updateAppointment(wsId, req.params.id, { status: "cancelled" });
    if (!appt) return res.status(404).json({ code: "not_found", message: "Appointment not found." });
    await db.writeAudit(wsId, { actorType: "user", actorId: req.auth?.userId, action: "appointment.cancelled", targetType: "appointment", targetId: appt.id });
    res.json({ appointment: appt });
  }));

  r.post("/appointments/:id/reschedule", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const { startsAt, durationMinutes } = req.body || {};
    if (!startsAt) return res.status(400).json({ code: "invalid_input", message: "New startsAt timestamp is required." });

    const patch = { starts_at: startsAt, status: "rescheduled" };
    if (durationMinutes) patch.duration_minutes = durationMinutes;

    const appt = await db.updateAppointment(wsId, req.params.id, patch);
    if (!appt) return res.status(404).json({ code: "not_found", message: "Appointment not found." });

    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "appointment.rescheduled",
      targetType: "appointment",
      targetId: appt.id,
      detail: { newStartsAt: startsAt },
    });

    broadcast(wsId, "appointment.rescheduled", { appointment: appt });
    res.json({ appointment: appt });
  }));

  /* =========================================================================
     PUBLIC BOOKING PORTAL ENDPOINTS
     ========================================================================= */

  r.get("/public/booking/:workspaceId/availability", handle(async (req, res) => {
    const wsId = req.params.workspaceId;
    const { date, serviceId, staffId, locationId, timezone } = req.query || {};
    if (!date) return res.status(400).json({ code: "invalid_input", message: "Date is required." });

    const slots = await getAvailableSlots(db, {
      workspaceId: wsId,
      locationId: locationId || null,
      serviceId: serviceId || null,
      staffId: staffId || null,
      date,
      timezone: timezone || "UTC",
    });

    res.json(slots);
  }));

  r.post("/public/booking/:workspaceId", handle(async (req, res) => {
    const wsId = req.params.workspaceId;
    const { name, email, phone, serviceId, staffId, locationId, startsAt, durationMinutes = 30 } = req.body || {};

    if (!startsAt) return res.status(400).json({ code: "invalid_input", message: "startsAt timestamp is required." });

    // Link or create contact
    let contact = null;
    if (phone || email) {
      contact = await db.findContactByPhoneOrEmail(wsId, { phone, email });
      if (!contact) {
        contact = await db.createContact(wsId, {
          name: name || "Customer",
          email: email || null,
          phone: phone || null,
          source: "public_booking",
        });
      }
    }

    const appt = await db.createAppointment(wsId, {
      contactId: contact?.id || null,
      staffId: staffId || null,
      serviceId: serviceId || null,
      locationId: locationId || null,
      startsAt,
      durationMinutes,
      status: "confirmed",
      source: "public_portal",
    });

    await db.writeAudit(wsId, {
      actorType: "customer",
      actorId: contact?.id,
      action: "appointment.booked_online",
      targetType: "appointment",
      targetId: appt.id,
      detail: { startsAt, durationMinutes },
    });

    broadcast(wsId, "appointment.created", { appointment: appt });
    res.status(201).json({ ok: true, appointment: appt, contact });
  }));

  return r;
}
