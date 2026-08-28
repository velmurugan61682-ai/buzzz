/**
 * AI Agent Runtime & Copilot Unit Tests.
 */
import { executeAgent, generateCopilotSuggestions, AGENT_TOOLS } from "./agent-runtime.js";

let fails = 0;
const ok = (c, m) => {
  if (!c) {
    console.log("  FAIL:", m);
    fails++;
  }
};

const makeMockDb = () => {
  const store = {
    contacts: [],
    appointments: [],
    conversations: [{ id: "conv_1", workspace_id: "ws1", state: "open" }],
    audits: [],
  };

  return {
    createContact: async (wsId, data) => {
      const c = { id: `cont_${Date.now()}`, workspace_id: wsId, ...data };
      store.contacts.push(c);
      return c;
    },
    updateContact: async (wsId, id, patch) => {
      const c = store.contacts.find((x) => x.workspace_id === wsId && x.id === id);
      if (!c) return null;
      Object.assign(c, patch);
      return c;
    },
    createAppointment: async (wsId, a) => {
      const appt = { id: `appt_${Date.now()}`, workspace_id: wsId, ...a };
      store.appointments.push(appt);
      return appt;
    },
    updateConversationState: async (wsId, id, state) => {
      const conv = store.conversations.find((x) => x.workspace_id === wsId && x.id === id);
      if (!conv) return null;
      conv.state = state;
      return conv;
    },
    writeAudit: async (wsId, a) => {
      store.audits.push({ id: `aud_${Date.now()}`, workspace_id: wsId, ...a });
      return { ok: true };
    },
    getService: async () => ({ duration_minutes: 30, capacity: 1 }),
    listStaffSchedules: async () => [{ start_time: "09:00", end_time: "17:00", day_of_week: 1 }],
    getStaffAppointmentsForDate: async () => [],
  };
};

const db = makeMockDb();
const mockAgent = {
  id: "agent_reception",
  name: "Reception Agent",
  role: "Clinic Receptionist",
  instructions: { greeting: "Welcome to our clinic! How can I assist you?" },
  tools: ["appointments.check_availability", "appointments.create_appointment", "messaging.escalate_to_human", "crm.create_contact"],
};

/* 1. Autonomous Appointment Scheduling */
const apptRun = await executeAgent({
  db,
  workspaceId: "ws1",
  agent: mockAgent,
  message: "I want to schedule an appointment on 2026-09-07 please",
  context: { contactId: "cont_100" },
});

ok(apptRun.ok === true, "executes agent successfully");
ok(apptRun.reply.includes("appointment has been successfully scheduled"), "generates appointment confirmation response");
ok(apptRun.toolExecutions.some((t) => t.tool === "appointments.create_appointment"), "autonomously calls create_appointment tool");

/* 2. Escalation to Human Handoff */
const escRun = await executeAgent({
  db,
  workspaceId: "ws1",
  agent: mockAgent,
  message: "I am really angry, I want to talk to a human manager immediately!",
  context: { conversationId: "conv_1" },
});

ok(escRun.ok === true, "handles escalation request");
ok(escRun.toolExecutions.some((t) => t.tool === "messaging.escalate_to_human"), "executes escalate_to_human tool");
ok(escRun.reply.includes("escalated your request"), "informs customer of handoff");

/* 3. Inbound Lead Qualification */
const leadRun = await executeAgent({
  db,
  workspaceId: "ws1",
  agent: mockAgent,
  message: "I am interested in your services and would like someone to contact me",
  context: { contactName: "Alice Smith", phone: "+1555444333" },
});

ok(leadRun.ok === true, "processes inbound lead");
ok(leadRun.toolExecutions.some((t) => t.tool === "crm.create_contact"), "creates CRM contact record");

/* 4. Copilot Suggestions */
const suggestions = generateCopilotSuggestions({
  lastMessage: "How much does a dental checkup cost?",
  customer: { name: "Sarah Connor" },
});
ok(Array.isArray(suggestions) && suggestions.length >= 2, "generates contextual copilot suggestions");

console.log(fails ? `agent runtime: ${fails} FAILED` : "agent runtime: all checks passed");
process.exit(fails ? 1 : 0);
