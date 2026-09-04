/**
 * Omnichannel Inbox & Messaging Routes.
 *
 * REST endpoints for Conversations, Messages, Assignments, Queues,
 * and External Webhook Ingestion.
 */

import { Router } from "express";
import { createInboxService } from "../lib/inbox.js";
import { getGoWhatsCapabilities } from "../lib/gowhats.js";

export function inboxRoutes({ db, config = {}, broadcast = () => {} }) {
  const r = Router();
  const inboxService = createInboxService({ db, config, broadcast });

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
     CAPABILITIES
     ========================================================================= */

  r.get("/channels/capabilities", (req, res) => {
    res.json({
      channels: {
        whatsapp: getGoWhatsCapabilities(),
        email: { channel: "email", sendText: true, sendImage: true, sendDocument: true, reactions: false },
        sms: { channel: "sms", sendText: true, sendImage: false, reactions: false },
      },
    });
  });

  /* =========================================================================
     CONVERSATIONS
     ========================================================================= */

  r.get("/conversations", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);
    const conversations = await db.listConversations(wsId, { limit });
    res.json({ data: conversations, count: conversations.length });
  }));

  r.post("/conversations", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const { contactId, channel = "whatsapp", assigneeId = null, agentId = null } = req.body || {};

    const conv = await db.createConversation(wsId, {
      contactId: contactId || null,
      channel,
      state: "open",
      assigneeId,
      agentId,
      aiEnabled: true,
    });

    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "conversation.created",
      targetType: "conversation",
      targetId: conv.id,
      detail: { channel, contactId },
    });

    res.status(201).json({ conversation: conv });
  }));

  r.get("/conversations/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const conv = await db.getConversation(wsId, req.params.id);
    if (!conv) return res.status(404).json({ code: "not_found", message: "Conversation not found." });
    res.json({ conversation: conv });
  }));

  r.patch("/conversations/:id", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const { state } = req.body || {};
    if (!state) return res.status(400).json({ code: "invalid_input", message: "State is required." });

    const updated = await db.updateConversationState(wsId, req.params.id, state);
    if (!updated) return res.status(404).json({ code: "not_found", message: "Conversation not found." });

    res.json({ conversation: updated });
  }));

  r.post("/conversations/:id/assign", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const { assigneeId, queueId } = req.body || {};

    const updated = await db.assignConversation(wsId, req.params.id, { assigneeId, queueId });
    if (!updated) return res.status(404).json({ code: "not_found", message: "Conversation not found." });

    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "conversation.assigned",
      targetType: "conversation",
      targetId: req.params.id,
      detail: { assigneeId, queueId },
    });

    res.json({ conversation: updated });
  }));

  r.post("/conversations/:id/close", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const updated = await db.updateConversationState(wsId, req.params.id, "resolved");
    if (!updated) return res.status(404).json({ code: "not_found", message: "Conversation not found." });

    await db.writeAudit(wsId, {
      actorType: "user",
      actorId: req.auth?.userId,
      action: "conversation.closed",
      targetType: "conversation",
      targetId: req.params.id,
    });

    res.json({ conversation: updated });
  }));

  /* =========================================================================
     MESSAGES
     ========================================================================= */

  r.get("/conversations/:id/messages", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const limit = Math.min(parseInt(req.query.limit || "100", 10), 200);
    const offset = parseInt(req.query.offset || "0", 10);
    const messages = await db.listMessages(wsId, req.params.id, { limit, offset });
    res.json({ data: messages, count: messages.length });
  }));

  r.post("/conversations/:id/messages", handle(async (req, res) => {
    const wsId = getWorkspaceId(req);
    const { body, media, isInternalNote = false } = req.body || {};

    if (!body && !media) {
      return res.status(400).json({ code: "invalid_input", message: "Message body or media is required." });
    }

    if (isInternalNote) {
      // Internal agent note (not sent to customer)
      const note = await db.createMessage(wsId, {
        conversationId: req.params.id,
        direction: "outbound",
        author: req.user?.name || "Agent (Internal Note)",
        body: `[INTERNAL NOTE] ${body}`,
        deliveryStatus: "internal",
      });
      return res.status(201).json({ message: note, isInternalNote: true });
    }

    const out = await inboxService.sendOutboundMessage({
      workspaceId: wsId,
      conversationId: req.params.id,
      body,
      media,
      author: req.user?.name || "Agent",
      isAi: false,
    });

    res.status(201).json(out);
  }));

  /* =========================================================================
     WEBHOOK INGESTION (GoWhats / WhatsApp & YouTube)
     ========================================================================= */

  r.post("/webhooks/gowhats", handle(async (req, res) => {
    const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId || "default_workspace";
    const signature = req.headers["x-gowhats-signature"] || req.headers["x-hub-signature-256"] || "";

    const out = await inboxService.processIncomingWhatsApp({
      workspaceId,
      rawBody: req.body,
      signature,
      payload: req.body,
    });

    res.json(out);
  }));

  const YOUTUBE_HOOK_PATHS = ["/webhooks/youtube", "/hooks/youtube", "/hooks/youtube/:id"];

  YOUTUBE_HOOK_PATHS.forEach((path) => {
    // GET: Subscription Verification Challenge (PubSubHubbub)
    r.get(path, handle(async (req, res) => {
      const challenge = req.query["hub.challenge"];
      if (challenge) {
        return res.status(200).type("text/plain").send(challenge);
      }
      res.json({
        ok: true,
        status: "active",
        channel: "youtube",
        endpoint: req.originalUrl || path,
      });
    }));

    // POST: Notification Event Ingestion
    r.post(path, handle(async (req, res) => {
      const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId || "default_workspace";
      const payload = req.body || {};
      const providerMessageId = payload.id || payload.commentId || `yt_wh_${Date.now()}`;

      if (db.recordWebhookDelivery) {
        await db.recordWebhookDelivery({
          workspaceId,
          provider: "youtube",
          eventId: providerMessageId,
          status: "processed",
        });
      }

      res.json({
        ok: true,
        received: true,
        providerMessageId,
        endpoint: req.originalUrl || path,
        timestamp: new Date().toISOString(),
      });
    }));
  });

  return r;
}
