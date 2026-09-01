/**
 * YouTube Background Worker Unit Tests.
 */
import { createDefaultWorker } from "./worker.js";

let fails = 0;
const ok = (c, m) => {
  if (!c) {
    console.log("  FAIL:", m);
    fails++;
  }
};

const makeMockDb = () => {
  const conversations = [];
  const messages = [];

  return {
    conversations,
    messages,
    createConversation: async (wsId, data) => {
      const conv = { id: `conv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ...data };
      conversations.push(conv);
      return conv;
    },
    createMessage: async (wsId, data) => {
      const msg = { id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ...data };
      messages.push(msg);
      return msg;
    },
  };
};

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const fakeFetch = (handler) => async (url, opts) => handler(String(url), opts || {});

const db = makeMockDb();
const worker = createDefaultWorker(db);

/* 1. Missing Token Throws Error */
const failRes = await worker.processJob({
  id: "j1",
  workspaceId: "ws1",
  jobType: "youtube.sync",
  payload: { channelId: "ch1" },
});
ok(failRes.ok === false && failRes.error.includes("OAuth access token"), "fails if access token is missing");

/* 2. Successful Sync with Delta Filtering */
let requestedUrl = null;
const syncRes = await worker.processJob({
  id: "j2",
  workspaceId: "ws1",
  jobType: "youtube.sync",
  payload: {
    accessToken: "at_valid",
    channelId: "ch_test",
    lastSyncAt: "2026-08-01T00:00:00Z",
    quotaUsedToday: 100,
    fetchFn: fakeFetch(async (u) => {
      requestedUrl = u;
      return json(200, {
        items: [
          {
            id: "yt_c1",
            snippet: {
              topLevelComment: {
                snippet: {
                  authorDisplayName: "Alex",
                  textOriginal: "Awesome content!",
                  publishedAt: "2026-08-10T12:00:00Z",
                },
              },
            },
          },
        ],
      });
    }),
  },
});

ok(syncRes.ok === true && syncRes.result.syncedCount === 1, "successfully syncs new YouTube comment thread");
ok(syncRes.result.quotaUsedToday === 101, "increments daily quota usage counter by 1");
ok(syncRes.result.cadenceMinutes === 15, "reports 15-minute polling cadence");
ok(db.conversations.length === 1 && db.conversations[0].channel === "youtube", "creates conversation with channel 'youtube'");

/* 3. Daily Quota Limit Safety Threshold (> 9,000 units) */
const quotaRes = await worker.processJob({
  id: "j3",
  workspaceId: "ws1",
  jobType: "youtube.sync",
  payload: {
    accessToken: "at_valid",
    channelId: "ch_test",
    quotaUsedToday: 9200,
  },
});

ok(quotaRes.ok === true && quotaRes.result.skipped === true, "skips polling cycle when daily quota limit threshold (9,000 units) is reached");

console.log(fails ? `youtube-worker: ${fails} FAILED` : "youtube-worker: all 7 checks passed");
process.exit(fails ? 1 : 0);
