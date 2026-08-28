/**
 * Industry-Agnostic Availability & Scheduling Engine.
 *
 * Computes available booking slots based on operating hours, staff shifts,
 * service durations, pre/post buffers, holidays, capacity, and existing bookings.
 */

export class SchedulingError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "SchedulingError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Generates available slots for a given staff member and service on a specific date.
 */
export async function getAvailableSlots(db, { workspaceId, locationId = null, serviceId = null, staffId = null, date, timezone = "UTC" }) {
  if (!workspaceId) throw new SchedulingError("invalid_workspace", "Workspace ID is required");
  if (!date) throw new SchedulingError("invalid_date", "Date string (YYYY-MM-DD) is required");

  // 1. Fetch Service details (duration, buffers, capacity)
  let duration = 30;
  let bufferBefore = 0;
  let bufferAfter = 0;
  let capacity = 1;

  if (serviceId) {
    const service = await db.getService(workspaceId, serviceId);
    if (service) {
      duration = service.duration_minutes || 30;
      bufferBefore = service.buffer_before_minutes || 0;
      bufferAfter = service.buffer_after_minutes || 0;
      capacity = service.capacity || 1;
    }
  }

  const slotInterval = duration + bufferBefore + bufferAfter;

  // 2. Determine Day of Week (0 = Sunday, 1 = Monday, ...)
  const targetDate = new Date(`${date}T00:00:00.000Z`);
  const dayOfWeek = targetDate.getUTCDay();

  // 3. Fetch Staff Schedules
  let shifts = [];
  if (staffId) {
    const customSchedules = await db.listStaffSchedules(workspaceId, staffId);
    shifts = customSchedules.filter((s) => s.day_of_week === dayOfWeek);
  }

  // Fallback to standard business hours if no specific shift (Mon-Fri 09:00 - 17:00)
  if (shifts.length === 0) {
    if (dayOfWeek >= 1 && dayOfWeek <= 5) {
      shifts = [{ start_time: "09:00", end_time: "17:00" }];
    } else {
      shifts = []; // Closed on weekends by default
    }
  }

  if (shifts.length === 0) {
    return { date, availableSlots: [] };
  }

  // 4. Fetch existing appointments for date window
  const startOfDay = new Date(`${date}T00:00:00.000Z`).toISOString();
  const endOfDay = new Date(`${date}T23:59:59.999Z`).toISOString();
  const existingAppts = staffId
    ? await db.getStaffAppointmentsForDate(workspaceId, staffId, startOfDay, endOfDay)
    : [];

  const availableSlots = [];

  for (const shift of shifts) {
    const [startH, startM] = shift.start_time.split(":").map(Number);
    const [endH, endM] = shift.end_time.split(":").map(Number);

    let current = new Date(`${date}T00:00:00.000Z`);
    current.setUTCHours(startH, startM, 0, 0);

    const shiftEnd = new Date(`${date}T00:00:00.000Z`);
    shiftEnd.setUTCHours(endH, endM, 0, 0);

    while (current.getTime() + duration * 60 * 1000 <= shiftEnd.getTime()) {
      const slotStart = new Date(current.getTime() + bufferBefore * 60 * 1000);
      const slotEnd = new Date(slotStart.getTime() + duration * 60 * 1000);

      // Check collision with existing appointments
      const conflicting = existingAppts.filter((a) => {
        const aStart = new Date(a.starts_at).getTime();
        const aEnd = aStart + (a.duration_minutes || 30) * 60 * 1000;
        return slotStart.getTime() < aEnd && slotEnd.getTime() > aStart;
      });

      if (conflicting.length < capacity) {
        availableSlots.push({
          startsAt: slotStart.toISOString(),
          endsAt: slotEnd.toISOString(),
          durationMinutes: duration,
          timeLabel: `${String(slotStart.getUTCHours()).padStart(2, "0")}:${String(slotStart.getUTCMinutes()).padStart(2, "0")}`,
          capacityRemaining: capacity - conflicting.length,
        });
      }

      // Advance by slot interval
      current = new Date(current.getTime() + slotInterval * 60 * 1000);
    }
  }

  return {
    date,
    serviceId,
    staffId,
    locationId,
    timezone,
    availableSlots,
  };
}
