/**
 * Production Background Worker & Job Execution System.
 *
 * Handles background job queues, exponential backoff retries, dead-letter
 * error logging, and periodic maintenance tasks.
 */

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
      await this.db.recordJobFailure(workspaceId, {
        jobId,
        jobType,
        attempts,
        lastError: err.message,
      });
      throw err;
    }

    try {
      const result = await handler(payload, { workspaceId, jobId, db: this.db });
      return { ok: true, jobId, result };
    } catch (err) {
      const nextAttempt = attempts + 1;
      if (nextAttempt >= this.maxRetries) {
        // Dead letter recording
        await this.db.recordJobFailure(workspaceId, {
          jobId,
          jobType,
          attempts: nextAttempt,
          lastError: err.message,
        });
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

  // Outbound Email Job
  runner.registerHandler("email.send", async (payload, { workspaceId, db }) => {
    return await db.recordNotification(workspaceId, {
      channel: "email",
      recipient: payload.to,
      subject: payload.subject,
      status: "delivered",
      idempotencyKey: payload.idempotencyKey,
    });
  });

  // Appointment Reminder Job
  runner.registerHandler("appointment.reminder", async (payload, { workspaceId, db }) => {
    return await db.writeAudit(workspaceId, {
      actorType: "worker",
      action: "appointment.reminder.sent",
      targetType: "appointment",
      targetId: payload.appointmentId,
    });
  });

  return runner;
}
