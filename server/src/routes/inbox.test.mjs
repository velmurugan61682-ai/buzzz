/**
 * Omnichannel Inbox, Conversations & Messaging Integration Tests.
 */
import { inboxRoutes } from "./inbox.js";

let fails = 0;
const ok = (c, m) => {
  if (!c) {
    console.log("  FAIL:", m);
    fails++;
  }
};

const makeInboxMockDb = () => {
  const store = {
    contacts: [],
    conversations: [],
    messages: [],
    appointments: [],
    deliveries: [],
    audits: [],
  };

  return {
    listConversations: async (wsId, { limit = 50 } = {}) =>
      store.conversations.filter((c) => c.workspace_id === wsId).slice(0, limit),
    getConversation: async (wsId, id) =>
      store.conversations.find((c) => c.workspace_id === wsId && c.id === id) || null,
    createConversation: async (wsId, data) => {
      const conv = {
        id: `conv_${Date.now()}_${Math.random()}`,
        workspace_id: wsId,
        ...data,
        ai_enabled: data.aiEnabled ?? data.ai_enabled ?? true,
        created_at: new Date().toISOString(),
        last_message_at: new Date().toISOString(),
      };
      store.conversations.push(conv);
      return conv;
    },
    updateConversationState: async (wsId, id, state) => {
      const conv = store.conversations.find((c) => c.workspace_id === wsId && c.id === id);
      if (!conv) return null;
      conv.state = state;
      conv.last_message_at = new Date().toISOString();
      return conv;
    },
    assignConversation: async (wsId, id, { assigneeId, queueId }) => {
      const conv = store.conversations.find((c) => c.workspace_id === wsId && c.id === id);
      if (!conv) return null;
      if (assigneeId) conv.assignee_id = assigneeId;
      if (queueId) conv.queue_id = queueId;
      return conv;
    },
    findConversationByContact: async (wsId, contactId, channel) =>
      store.conversations.find(
        (c) => c.workspace_id === wsId && c.contact_id === contactId && c.channel === channel
      ) || null,

    listMessages: async (wsId, convId, { limit = 50 } = {}) =>
      store.messages.filter((m) => m.workspace_id === wsId && m.conversation_id === convId).slice(0, limit),
    createMessage: async (wsId, data) => {
      const msg = {
        id: `msg_${Date.now()}_${Math.random()}`,
        workspace_id: wsId,
        conversation_id: data.conversationId || data.conversation_id,
        ...data,
        created_at: new Date().toISOString(),
      };
      store.messages.push(msg);
      return msg;
    },
    updateMessageDeliveryStatus: async (wsId, providerMessageId, status) => {
      const msg = store.messages.find(
        (m) => m.workspace_id === wsId && (m.provider_message_id === providerMessageId || m.id === providerMessageId)
      );
      if (msg) msg.delivery_status = status;
      return msg;
    },

    findContactByPhoneOrEmail: async (wsId, { phone, email }) =>
      store.contacts.find(
        (c) => c.workspace_id === wsId && ((phone && c.phone === phone) || (email && c.email === email))
      ) || null,
    getContact: async (wsId, id) =>
      store.contacts.find((c) => c.workspace_id === wsId && c.id === id) || null,
    createContact: async (wsId, data) => {
      const c = { id: `cont_${Date.now()}_${Math.random()}`, workspace_id: wsId, ...data, created_at: new Date().toISOString() };
      store.contacts.push(c);
      return c;
    },

    createAppointment: async (wsId, data) => {
      const appt = { id: `appt_${Date.now()}`, workspace_id: wsId, ...data, created_at: new Date().toISOString() };
      store.appointments.push(appt);
      return appt;
    },

    findWebhookDelivery: async (provider, eventId) =>
      store.deliveries.find((d) => d.provider === provider && d.event_id === eventId) || null,
    recordWebhookDelivery: async (data) => {
      const existing = store.deliveries.find((d) => d.provider === data.provider && d.event_id === data.eventId);
      if (existing) {
        existing.status = data.status;
        return existing;
      }
      const d = { id: `del_${Date.now()}`, ...data, event_id: data.eventId };
      store.deliveries.push(d);
      return d;
    },

    writeAudit: async (wsId, e) => {
      store.audits.push({ id: `aud_${Date.now()}`, workspace_id: wsId, ...e });
      return { ok: true };
    },
  };
};

const db = makeInboxMockDb();
const broadcasts = [];
const router = inboxRoutes({
  db,
  config: { gowhatsWebhookSecret: "" },
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
    type: () => res,
    send: (data) => {
      jsonBody = data;
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
   1. INCOMING WHATSAPP WEBHOOK & AI INTENT APPOINTMENT BOOKING
   ========================================================================= */
const incomingWebhookRes = await dispatch("POST", "/webhooks/gowhats", {
  workspace: { id: "ws_alpha", role: "admin" },
  body: {
    id: "gw_evt_1001",
    from: "+14155552671",
    name: "Michael Scott",
    text: "Hi, I would like to schedule an appointment tomorrow please.",
  },
});

ok(incomingWebhookRes.status === 200, "processes incoming WhatsApp webhook");
ok(incomingWebhookRes.body.ok === true, "returns success confirmation");
ok(incomingWebhookRes.body.contact.phone === "+14155552671", "automatically creates/links CRM contact");
ok(incomingWebhookRes.body.conversation.channel === "whatsapp", "creates whatsapp conversation thread");
ok(incomingWebhookRes.body.message.body.includes("appointment"), "persists inbound message");
ok(incomingWebhookRes.body.aiResponse !== null, "AI autonomously detects appointment request and sends reply");

/* =========================================================================
   2. WEBHOOK IDEMPOTENCY
   ========================================================================= */
const dupWebhookRes = await dispatch("POST", "/webhooks/gowhats", {
  workspace: { id: "ws_alpha", role: "admin" },
  body: {
    id: "gw_evt_1001", // duplicate provider message ID
    from: "+14155552671",
    text: "Hi, I would like to schedule an appointment tomorrow please.",
  },
});
ok(dupWebhookRes.status === 200 && dupWebhookRes.body.duplicate === true, "idempotently ignores duplicate webhook delivery");

/* =========================================================================
   3. OUTBOUND MESSAGING & INTERNAL NOTES
   ========================================================================= */
const convId = incomingWebhookRes.body.conversation.id;

// Send manual agent reply
const replyRes = await dispatch("POST", `/conversations/${convId}/messages`, {
  body: { body: "Doctor Smith is assigned to your appointment." },
});
ok(replyRes.status === 201, "sends outbound reply");

// Add internal agent note
const noteRes = await dispatch("POST", `/conversations/${convId}/messages`, {
  body: { body: "VIP client - requested Dr. Smith specifically.", isInternalNote: true },
});
ok(noteRes.status === 201 && noteRes.body.isInternalNote === true, "creates internal note without sending to customer");

// List conversation messages
const listMsgRes = await dispatch("GET", `/conversations/${convId}/messages`);
ok(listMsgRes.status === 200, "lists messages");
ok(listMsgRes.body.data.length >= 3, "retrieves all chronological conversation entries");

/* =========================================================================
   4. CONVERSATION STATE & ASSIGNMENT
   ========================================================================= */
const assignRes = await dispatch("POST", `/conversations/${convId}/assign`, {
  body: { assigneeId: "user_agent_42" },
});
ok(assignRes.status === 200 && assignRes.body.conversation.assignee_id === "user_agent_42", "assigns conversation to agent");

const closeRes = await dispatch("POST", `/conversations/${convId}/close`);
ok(closeRes.status === 200 && closeRes.body.conversation.state === "resolved", "resolves and closes conversation");

/* =========================================================================
   6. YOUTUBE WEBHOOK & HOOK ENDPOINTS
   ========================================================================= */
const ytChallengeRes = await dispatch("GET", "/hooks/youtube/wk_youtube9f2a", {
  query: { "hub.challenge": "challenge_abc123" },
});
ok(ytChallengeRes.status === 200, "responds 200 to YouTube subscription challenge request");

const ytPostRes = await dispatch("POST", "/hooks/youtube/wk_youtube9f2a", {
  body: { commentId: "yt_cmt_99", text: "New comment received" },
});
ok(ytPostRes.status === 200 && ytPostRes.body.received === true, "processes incoming YouTube notification event on /hooks/youtube/:id endpoint");

console.log(fails ? `inbox tests: ${fails} FAILED` : "inbox tests: all checks passed");
process.exit(fails ? 1 : 0);
