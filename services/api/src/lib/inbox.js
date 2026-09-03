/**
 * Omnichannel Inbox & Messaging Orchestrator.
 *
 * Coordinates message ingestion, CRM contact linking, AI automation,
 * appointment scheduling intents, delivery tracking, and loop prevention.
 */

import { verifyGoWhatsWebhookSignature, normalizeGoWhatsEvent, sendWhatsAppMessageFromStore } from "./gowhats.js";

export class InboxError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "InboxError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Creates the Inbox messaging service.
 */
export function createInboxService({ db, config = {}, broadcast = () => {} }) {
  /**
   * Processes an incoming WhatsApp webhook event with idempotency and AI automation.
   */
  const processIncomingWhatsApp = async ({ workspaceId, rawBody, signature, payload }) => {
    // 1. Signature validation
    const secret = config.gowhatsWebhookSecret || "";
    if (secret && !verifyGoWhatsWebhookSignature(rawBody || payload, signature, secret)) {
      throw new InboxError("invalid_signature", "Webhook signature verification failed", 401);
    }

    // 2. Event normalization
    const event = normalizeGoWhatsEvent(payload);

    // 3. Idempotency check
    const existing = await db.findWebhookDelivery("gowhats", event.providerMessageId);
    if (existing && existing.status === "processed") {
      return { duplicate: true, eventId: event.providerMessageId };
    }

    await db.recordWebhookDelivery({
      workspaceId,
      provider: "gowhats",
      eventId: event.providerMessageId,
      status: "processing",
    });

    // 4. Handle delivery status updates (delivered, read, failed)
    if (event.type === "status_update") {
      await db.updateMessageDeliveryStatus(workspaceId, event.providerMessageId, event.status);
      broadcast(workspaceId, "message.status", {
        providerMessageId: event.providerMessageId,
        status: event.status,
      });
      await db.recordWebhookDelivery({
        workspaceId,
        provider: "gowhats",
        eventId: event.providerMessageId,
        status: "processed",
      });
      return { ok: true, type: "status_update" };
    }

    // 5. Inbound message: Link or create CRM contact
    let contact = await db.findContactByPhoneOrEmail(workspaceId, { phone: event.from });
    if (!contact) {
      contact = await db.createContact(workspaceId, {
        name: event.author || `WhatsApp ${event.from}`,
        phone: event.from,
        source: "whatsapp",
        status: "New",
      });
    }

    // 6. Link or create conversation thread
    let conversation = await db.findConversationByContact(workspaceId, contact.id, "whatsapp");
    if (!conversation || conversation.state === "resolved") {
      conversation = await db.createConversation(workspaceId, {
        contactId: contact.id,
        channel: "whatsapp",
        state: "open",
        aiEnabled: true,
      });
    }

    // 7. Persist inbound message
    const message = await db.createMessage(workspaceId, {
      conversationId: conversation.id,
      direction: "inbound",
      author: event.author,
      body: event.body,
      media: event.media,
      providerMessageId: event.providerMessageId,
      deliveryStatus: "delivered",
    });

    // 8. Audit event
    await db.writeAudit(workspaceId, {
      actorType: "customer",
      actorId: contact.id,
      action: "message.received",
      targetType: "conversation",
      targetId: conversation.id,
      detail: { channel: "whatsapp", from: event.from, messageId: message.id },
    });

    broadcast(workspaceId, "message.created", { conversationId: conversation.id, message });

    // 9. AI Autonomous Intent Processing (e.g. Appointment booking request)
    let aiResponse = null;
    const isAiEnabled = conversation.ai_enabled ?? conversation.aiEnabled ?? true;
    if (isAiEnabled && event.body && !event.isAiGenerated) {
      const lower = event.body.toLowerCase();
      if (lower.includes("appointment") || lower.includes("book") || lower.includes("schedule")) {
        // Intent detected: Schedule appointment tomorrow at 10am
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(10, 0, 0, 0);

        try {
          const appt = await db.createAppointment(workspaceId, {
            contactId: contact.id,
            startsAt: tomorrow.toISOString(),
            durationMinutes: 30,
            status: "confirmed",
            source: "ai_whatsapp",
          });

          // Log appointment audit
          await db.writeAudit(workspaceId, {
            actorType: "agent",
            action: "appointment.booked_by_ai",
            targetType: "appointment",
            targetId: appt.id,
            detail: { contactId: contact.id, startsAt: appt.starts_at },
          });

          // Send confirmation response via WhatsApp
          const replyText = `Your appointment has been confirmed for tomorrow at 10:00 AM. We look forward to seeing you!`;
          aiResponse = await sendOutboundMessage({
            workspaceId,
            conversationId: conversation.id,
            body: replyText,
            author: "BUZZZ AI Assistant",
            isAi: true,
          });
        } catch (err) {
          // If conflict or failure, escalate to human agent
          await db.updateConversationState(workspaceId, conversation.id, "escalated");
          broadcast(workspaceId, "conversation.escalated", { conversationId: conversation.id, reason: err.message });
        }
      }
    }

    await db.recordWebhookDelivery({
      workspaceId,
      provider: "gowhats",
      eventId: event.providerMessageId,
      status: "processed",
    });

    return {
      ok: true,
      contact,
      conversation,
      message,
      aiResponse,
    };
  };

  /**
   * Sends an outbound message and dispatches it to the channel provider.
   */
  const sendOutboundMessage = async ({ workspaceId, conversationId, body, media = null, author = "Agent", isAi = false }) => {
    const conversation = await db.getConversation(workspaceId, conversationId);
    if (!conversation) {
      throw new InboxError("not_found", "Conversation not found", 404);
    }

    // Retrieve recipient phone from contact
    let recipientPhone = null;
    if (conversation.contact_id) {
      const contact = await db.getContact(workspaceId, conversation.contact_id);
      if (contact) recipientPhone = contact.phone;
    }

    // Persist outbound message in DB first
    const message = await db.createMessage(workspaceId, {
      conversationId,
      direction: "outbound",
      author,
      body,
      media,
      deliveryStatus: "sending",
    });

    // Dispatch to provider if WhatsApp
    let providerResult = null;
    if (conversation.channel === "whatsapp" && recipientPhone) {
      try {
        providerResult = await sendWhatsAppMessageFromStore(
          { to: recipientPhone, body, media },
          {
            workspaceId,
            db,
            credentialKey:  config.credentialKey,
            baseUrl:        config.whatsappBaseUrl || "https://graph.facebook.com/v20.0",
            phoneNumberId:  config.whatsappPhoneNumberId,
          },
        );
        await db.updateMessageDeliveryStatus(workspaceId, message.provider_message_id || message.id, "sent");
      } catch (err) {
        await db.updateMessageDeliveryStatus(workspaceId, message.provider_message_id || message.id, "failed");
        throw err;
      }
    }

    await db.writeAudit(workspaceId, {
      actorType: isAi ? "agent" : "user",
      action: "message.sent",
      targetType: "conversation",
      targetId: conversationId,
      detail: { channel: conversation.channel, messageId: message.id },
    });

    broadcast(workspaceId, "message.created", { conversationId, message });

    return { ok: true, message, providerResult };
  };

  return {
    processIncomingWhatsApp,
    sendOutboundMessage,
  };
}
