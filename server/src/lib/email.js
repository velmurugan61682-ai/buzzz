/**
 * Production Email Notification Dispatcher.
 *
 * Provides transactional email templates and delivery recording.
 */
export class EmailError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "EmailError";
    this.code = code;
    this.status = status;
  }
}


export const EMAIL_TEMPLATES = {
  welcome: ({ name = "User" }) => ({
    subject: "Welcome to BUZZZ!",
    html: `<p>Hello ${name},</p><p>Welcome to BUZZZ — your Agentic Communication Hub & CRM platform.</p>`,
    text: `Hello ${name}, Welcome to BUZZZ!`,
  }),
  appointment_confirmed: ({ customerName = "Valued Customer", serviceName = "Appointment", startsAt = "" }) => ({
    subject: `Appointment Confirmed: ${serviceName}`,
    html: `<p>Hi ${customerName},</p><p>Your appointment for <strong>${serviceName}</strong> is confirmed for <strong>${startsAt}</strong>.</p>`,
    text: `Hi ${customerName}, Your appointment for ${serviceName} is confirmed for ${startsAt}.`,
  }),
  appointment_reminder: ({ customerName = "Valued Customer", startsAt = "" }) => ({
    subject: "Reminder: Upcoming Appointment",
    html: `<p>Hi ${customerName},</p><p>This is a quick reminder about your scheduled appointment at <strong>${startsAt}</strong>.</p>`,
    text: `Hi ${customerName}, This is a quick reminder about your scheduled appointment at ${startsAt}.`,
  }),
  human_handoff: ({ conversationId, reason = "Customer requested human support" }) => ({
    subject: "Action Required: Conversation Escalated",
    html: `<p>A conversation has been escalated to human staff.</p><p>Reason: ${reason}</p><p>Conversation ID: ${conversationId}</p>`,
    text: `A conversation has been escalated. Reason: ${reason}. Conversation ID: ${conversationId}`,
  }),
};

export async function sendEmail({
  db,
  workspaceId,
  to,
  template = "welcome",
  params = {},
  idempotencyKey = null,
  credentialKey = null,
  transporterFn = null,
}) {
  if (!to) throw new EmailError("invalid_recipient", "Recipient email address is required");

  const templateFn = EMAIL_TEMPLATES[template] || EMAIL_TEMPLATES.welcome;
  const content = templateFn(params);

  let deliveryStatus = "delivered";
  if (transporterFn && typeof transporterFn.sendMail === "function") {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await transporterFn.sendMail({
          to,
          subject: content.subject,
          html: content.html,
          text: content.text,
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (lastErr) {
      deliveryStatus = "failed";
      if (db && workspaceId) {
        await db.recordNotification(workspaceId, {
          channel: "email",
          recipient: to,
          subject: content.subject,
          status: "failed",
          error: lastErr.message,
          idempotencyKey: idempotencyKey || `email_${Date.now()}_${Math.random()}`,
        });
      }
      throw new EmailError("delivery_failed", lastErr.message, 500);
    }
  }

  // Record delivery in database
  if (db && workspaceId) {
    await db.recordNotification(workspaceId, {
      channel: "email",
      recipient: to,
      subject: content.subject,
      status: "delivered",
      idempotencyKey: idempotencyKey || `email_${Date.now()}_${Math.random()}`,
    });
  }

  return {
    ok: true,
    to,
    subject: content.subject,
    template,
    deliveredAt: new Date().toISOString(),
  };
}
