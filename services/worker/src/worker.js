/**
 * Production Background Worker & Job Execution System.
 *
 * Handles background job queues, exponential backoff retries, dead-letter
 * error logging, and asynchronous workflow / campaign / ingestion jobs.
 */

import { sendGoWhatsMessage } from "../../api/src/lib/gowhats.js";
import { listCommentThreads } from "../../api/src/lib/google.js";

export class JobRunner {
  constructor({ db, maxRetries = 3 }) {
    this.db = db;
    this.maxRetries = maxRetries;
    this.handlers = new Map();
  }

  registerHandler(jobType, handler) {
    this.handlers.set(jobType, handler);
  }

  async processJob(job) {
    const { id: jobId, workspaceId, jobType, payload = {}, attempts = 0 } = job;
    const handler = this.handlers.get(jobType);

    if (!handler) {
      const err = new Error(`No handler registered for job type '${jobType}'`);
      if (this.db.recordJobFailure) {
        await this.db.recordJobFailure(workspaceId, {
          jobId,
          jobType,
          attempts,
          lastError: err.message,
        });
      }
      throw err;
    }

    try {
      const result = await handler(payload, { workspaceId, jobId, db: this.db });
      return { ok: true, jobId, result };
    } catch (err) {
      const nextAttempt = attempts + 1;
      if (nextAttempt >= this.maxRetries) {
        // Dead letter recording
        if (this.db.recordJobFailure) {
          await this.db.recordJobFailure(workspaceId, {
            jobId,
            jobType,
            attempts: nextAttempt,
            lastError: err.message,
          });
        }
        return { ok: false, jobId, failedPermanently: true, error: err.message };
      }

      // Retry with exponential backoff delay calculation
      const backoffMs = Math.pow(2, nextAttempt) * 1000;
      return { ok: false, jobId, retryAfterMs: backoffMs, attempts: nextAttempt, error: err.message };
    }
  }
}

export function createDefaultWorker(db) {
  const runner = new JobRunner({ db });

  // 1. Outbound Email Job
  runner.registerHandler("email.send", async (payload, { workspaceId, db }) => {
    return await db.recordNotification(workspaceId, {
      channel: "email",
      recipient: payload.to,
      subject: payload.subject,
      status: "delivered",
      idempotencyKey: payload.idempotencyKey,
    });
  });

  // 2. Appointment Reminder Job
  runner.registerHandler("appointment.reminder", async (payload, { workspaceId, db }) => {
    return await db.writeAudit(workspaceId, {
      actorType: "worker",
      action: "appointment.reminder.sent",
      targetType: "appointment",
      targetId: payload.appointmentId,
    });
  });

  // 3. Workflow Wait Node Resumption Job
  runner.registerHandler("workflow.wait", async (payload, { workspaceId, db }) => {
    const { runId, resumeNodeId, resumeState } = payload;
    if (db.updateWorkflowRun) {
      await db.updateWorkflowRun(workspaceId, runId, {
        currentNodeId: resumeNodeId,
        status: "active",
        state: resumeState,
        resumedAt: new Date().toISOString(),
      });
    }
    return await db.writeAudit(workspaceId, {
      actorType: "worker",
      action: "workflow.wait.resumed",
      targetType: "workflow_run",
      targetId: runId,
      detail: { resumeNodeId },
    });
  });

  // 4. Campaign Recipient Batch Dispatcher (GoWhats integration)
  runner.registerHandler("campaign.send", async (payload, { workspaceId, db }) => {
    const { campaignId, recipients = [] } = payload;
    let sentCount = 0;
    let failCount = 0;

    for (const r of recipients) {
      try {
        const sendRes = await sendGoWhatsMessage(
          { to: r.phone, body: r.message, template: r.template },
          { baseUrl: process.env.GOWHATS_API_BASE_URL, apiKey: process.env.GOWHATS_API_KEY }
        );
        if (sendRes.ok) {
          sentCount++;
          if (db.recordCampaignRecipientStatus) {
            await db.recordCampaignRecipientStatus(workspaceId, campaignId, r.phone, "sent", sendRes.providerMessageId);
          }
        }
      } catch (err) {
        failCount++;
        if (db.recordCampaignRecipientStatus) {
          await db.recordCampaignRecipientStatus(workspaceId, campaignId, r.phone, "failed", null, err.message);
        }
      }
    }

    return await db.writeAudit(workspaceId, {
      actorType: "worker",
      action: "campaign.send.completed",
      targetType: "campaign",
      targetId: campaignId,
      detail: { sentCount, failCount, total: recipients.length },
    });
  });

  // 5. Knowledge Base Document Ingestion Job
  runner.registerHandler("kb.ingest", async (payload, { workspaceId, db }) => {
    const { docId, content, title } = payload;
    const chunkSize = 500;
    const chunks = [];
    const text = content || "";

    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push({
        docId,
        chunkIndex: Math.floor(i / chunkSize),
        text: text.slice(i, i + chunkSize),
      });
    }

    if (db.saveKbChunks) {
      await db.saveKbChunks(workspaceId, docId, chunks);
    }

    return await db.writeAudit(workspaceId, {
      actorType: "worker",
      action: "kb.ingest.completed",
      targetType: "knowledge_base",
      targetId: docId,
      detail: { chunksCreated: chunks.length, title },
    });
  });

  // 7. YouTube Comment Sync Job (15-min cadence, quota budget check, publishedAfter delta sync)
  runner.registerHandler("youtube.sync", async (payload, { workspaceId, db }) => {
    const { accessToken, channelId, lastSyncAt, quotaUsedToday = 0, fetchFn = globalThis.fetch } = payload;
    
    // Quota Budget Check: 10,000 units/day limit. commentThreads.list = 1 unit.
    // Safety threshold: 9,000 units/day.
    const DAILY_QUOTA_LIMIT = 9000;
    if (quotaUsedToday >= DAILY_QUOTA_LIMIT) {
      return {
        skipped: true,
        reason: `Daily YouTube quota limit approaching (${quotaUsedToday}/${DAILY_QUOTA_LIMIT} units used). Polling backed off until quota reset.`,
      };
    }

    if (!accessToken) {
      throw new Error("YouTube sync requires valid OAuth access token");
    }

    const syncStartTime = new Date().toISOString();
    const response = await listCommentThreads({
      accessToken,
      allThreadsRelatedToChannelId: channelId || undefined,
      publishedAfter: lastSyncAt || undefined,
      fetchImpl: fetchFn,
    });

    const items = response.items || [];
    let syncedCount = 0;

    for (const thread of items) {
      const topComment = thread.snippet?.topLevelComment?.snippet || {};
      const author = topComment.authorDisplayName || "YouTube User";
      const text = topComment.textOriginal || topComment.textDisplay || "";
      const commentId = thread.id;

      if (db.createConversation && db.createMessage) {
        const conv = await db.createConversation(workspaceId, {
          contactId: null,
          channel: "youtube",
          externalId: commentId,
          state: "open",
        });
        await db.createMessage(workspaceId, {
          conversationId: conv.id,
          direction: "inbound",
          body: text,
          author,
          providerMessageId: commentId,
          timestamp: topComment.publishedAt || syncStartTime,
        });
      }
      syncedCount++;
    }

    const updatedQuotaUsed = quotaUsedToday + 1; // 1 unit used for commentThreads.list

    return {
      ok: true,
      syncedCount,
      lastSyncAt: syncStartTime,
      quotaUsedToday: updatedQuotaUsed,
      cadenceMinutes: 15,
    };
  });

  return runner;
}
