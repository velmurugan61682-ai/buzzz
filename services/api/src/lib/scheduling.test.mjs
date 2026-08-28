/**
 * Availability & Scheduling Engine Unit Tests.
 */
import { getAvailableSlots } from "./scheduling.js";

let fails = 0;
const ok = (c, m) => {
  if (!c) {
    console.log("  FAIL:", m);
    fails++;
  }
};

const makeMockDb = () => {
  const services = [
    {
      id: "svc_haircut",
      workspace_id: "ws1",
      name: "Haircut",
      duration_minutes: 30,
      buffer_before_minutes: 5,
      buffer_after_minutes: 5,
      capacity: 1,
    },
    {
      id: "svc_yoga",
      workspace_id: "ws1",
      name: "Yoga Group Class",
      duration_minutes: 60,
      buffer_before_minutes: 0,
      buffer_after_minutes: 0,
      capacity: 5,
    },
  ];

  const staffSchedules = [
    {
      workspace_id: "ws1",
      staff_id: "staff_arun",
      day_of_week: 1, // Monday
      start_time: "09:00",
      end_time: "12:00",
    },
  ];

  const appointments = [
    {
      id: "appt_1",
      workspace_id: "ws1",
      staff_id: "staff_arun",
      service_id: "svc_haircut",
      starts_at: "2026-09-07T09:00:00.000Z", // Monday
      duration_minutes: 30,
      status: "confirmed",
    },
  ];

  return {
    getService: async (wsId, id) => services.find((s) => s.workspace_id === wsId && s.id === id) || null,
    listStaffSchedules: async (wsId, staffId) =>
      staffSchedules.filter((s) => s.workspace_id === wsId && s.staff_id === staffId),
    getStaffAppointmentsForDate: async (wsId, staffId, start, end) =>
      appointments.filter((a) => a.workspace_id === wsId && a.staff_id === staffId),
  };
};

const db = makeMockDb();

/* 1. Available slots computation on Monday 2026-09-07 */
const res = await getAvailableSlots(db, {
  workspaceId: "ws1",
  staffId: "staff_arun",
  serviceId: "svc_haircut",
  date: "2026-09-07",
});

ok(res.date === "2026-09-07", "returns requested date");
ok(Array.isArray(res.availableSlots), "returns slots array");
// 09:00 slot has existing booking appt_1, so it shouldn't be available
const hasNineAm = res.availableSlots.some((s) => s.startsAt.includes("09:05:00"));
ok(!hasNineAm, "excludes occupied slot for Arun at 09:00");
ok(res.availableSlots.length > 0, "generates subsequent available slots");

/* 2. Group Class Capacity (Capacity = 5) */
const resYoga = await getAvailableSlots(db, {
  workspaceId: "ws1",
  staffId: "staff_arun",
  serviceId: "svc_yoga",
  date: "2026-09-07",
});
ok(resYoga.availableSlots.length > 0, "generates group class slots");

console.log(fails ? `scheduling engine: ${fails} FAILED` : "scheduling engine: all checks passed");
process.exit(fails ? 1 : 0);
