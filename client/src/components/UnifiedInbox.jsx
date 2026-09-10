import React, { useState, useEffect, useMemo } from "react";
import { PLATFORM_META, getPlatformMeta } from "../constants/platformMeta";

// SVG Platform Icons mapped by key
const PlatformIcon = ({ platform, className = "w-5 h-5" }) => {
  const meta = getPlatformMeta(platform);
  
  switch (meta.icon) {
    case "gmail":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z" />
        </svg>
      );
    case "instaxbot":
    case "instagram":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
        </svg>
      );
    case "linkedin":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z" />
        </svg>
      );
    case "gowhats":
    case "whatsapp":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981z" />
        </svg>
      );
    case "telegram":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm5.562 8.161c-.18.717-.962 4.084-1.362 5.762-.169.71-.431.948-.684.971-.55.05-1.047-.364-1.58-.713-.834-.546-1.304-.886-2.114-1.419-.936-.618-.329-.958.204-1.512.14-.145 2.569-2.355 2.616-2.556.006-.025.011-.121-.046-.171s-.144-.033-.206-.019c-.088.02-1.488.946-4.201 2.778-.397.272-.757.406-1.079.399-.356-.008-1.041-.202-1.55-.368-.625-.203-1.121-.311-1.078-.656.022-.18.271-.365.747-.555 2.923-1.272 4.873-2.112 5.85-2.52 2.788-1.16 3.367-1.362 3.746-1.369.083-.001.27.02.39.119.102.083.131.196.143.275.013.088.029.288.016.447z" />
        </svg>
      );
    case "youtube":
    case "channelbot":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
        </svg>
      );
    case "facebook":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
        </svg>
      );
    case "webhook":
    default:
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      );
  }
};

export function UnifiedInbox() {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activePlatform, setActivePlatform] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Client-side defensive deduplication function
  const dedupeMessages = (msgArray) => {
    const seen = new Set();
    const result = [];

    for (const msg of msgArray) {
      // Primary key: Mongo _id or client id or platform:externalMessageId
      const key = msg._id
        ? String(msg._id)
        : msg.id
        ? msg.id
        : `${msg.platform}:${msg.externalMessageId}`;

      if (!seen.has(key)) {
        seen.add(key);
        result.push({
          ...msg,
          _dedupeKey: key,
          platformMeta: getPlatformMeta(msg.platform),
        });
      }
    }

    // Sort by receivedAt desc
    return result.sort((a, b) => new Date(b.receivedAt || b.createdAt || Date.now()) - new Date(a.receivedAt || a.createdAt || Date.now()));
  };

  // Fetch initial messages from GET /api/inbox
  const loadInbox = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/inbox?limit=100");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data.messages && Array.isArray(data.messages)) {
        setMessages(dedupeMessages(data.messages));
      }
      setError(null);
    } catch (err) {
      console.error("❌ Failed to fetch unified inbox:", err);
      setError("Failed to load unified inbox messages");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadInbox();

    // Setup real-time EventSource (SSE) listener for new_message push events
    const eventSource = new EventSource("/api/events");

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "new_message" || payload.type === "message:new") {
          const newMsg = payload.payload?.message || payload.payload;
          if (newMsg && (newMsg.platform || newMsg.text)) {
            setMessages((prev) => dedupeMessages([newMsg, ...prev]));
          }
        }
      } catch (err) {
        console.warn("⚠️ Failed to parse SSE event payload:", err);
      }
    };

    return () => {
      eventSource.close();
    };
  }, []);

  // Filter messages by platform tab & search query
  const filteredMessages = useMemo(() => {
    return messages.filter((msg) => {
      const matchPlatform = activePlatform === "all" || msg.platform === activePlatform;
      const matchSearch =
        !searchQuery.trim() ||
        (msg.text && msg.text.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (msg.sender?.name && msg.sender.name.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (msg.sender?.handle && msg.sender.handle.toLowerCase().includes(searchQuery.toLowerCase()));

      return matchPlatform && matchSearch;
    });
  }, [messages, activePlatform, searchQuery]);

  return (
    <div className="flex flex-col h-full bg-slate-900 text-slate-100 rounded-xl border border-slate-800 shadow-2xl overflow-hidden">
      {/* Header & Filter Tabs */}
      <div className="p-4 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <span>📥 Unified Multi-Channel Inbox</span>
              <span className="text-xs bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full font-mono">
                LIVE DEDUPLICATED
              </span>
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Single source-of-truth inbox aggregating Gmail, Instagram, LinkedIn, WhatsApp, Telegram & Facebook
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Search messages..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-slate-800 text-slate-200 text-xs rounded-lg px-3 py-2 border border-slate-700 focus:outline-none focus:border-indigo-500 w-48 sm:w-64"
            />
            <button
              onClick={loadInbox}
              className="p-2 text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition"
              title="Refresh Inbox"
            >
              🔄
            </button>
          </div>
        </div>

        {/* Platform Filters */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
          {["all", "gmail", "instagram", "whatsapp", "youtube", "linkedin", "telegram", "facebook", "custom_webhook"].map((pKey) => {
            const meta = pKey === "all" ? { name: "All Platforms", color: "#6366F1" } : getPlatformMeta(pKey);
            const count = pKey === "all" ? messages.length : messages.filter((m) => m.platform === pKey).length;
            const isActive = activePlatform === pKey;

            return (
              <button
                key={pKey}
                onClick={() => setActivePlatform(pKey)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  isActive
                    ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/30"
                    : "bg-slate-800/80 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                }`}
              >
                {pKey !== "all" && <PlatformIcon platform={pKey} className="w-3.5 h-3.5" />}
                <span>{meta.name}</span>
                <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${isActive ? "bg-white/20 text-white" : "bg-slate-700 text-slate-400"}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Message List */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60 p-2">
        {loading ? (
          <div className="flex items-center justify-center p-12 text-slate-400 text-sm">
            <span className="animate-spin mr-2">🌀</span> Loading messages...
          </div>
        ) : error ? (
          <div className="p-8 text-center text-rose-400 text-sm">
            ❌ {error}
          </div>
        ) : filteredMessages.length === 0 ? (
          <div className="p-12 text-center text-slate-500 text-sm">
            No messages found for this platform filter.
          </div>
        ) : (
          filteredMessages.map((msg) => {
            // STRICT PLATFORM ICON LOOKUP FROM PLATFORM_META
            const meta = getPlatformMeta(msg.platform);

            return (
              <div
                key={msg._id || msg.id || msg._dedupeKey}
                className="group flex items-start gap-4 p-3.5 rounded-lg hover:bg-slate-800/50 transition cursor-pointer"
              >
                {/* Platform Badge Icon (Single source-of-truth driven) */}
                <div
                  className="relative flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-white shadow-md"
                  style={{ backgroundColor: meta.color }}
                  title={`Sent via ${meta.name}`}
                >
                  <PlatformIcon platform={msg.platform} className="w-5 h-5" />
                  <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-slate-900 rounded-full flex items-center justify-center border border-slate-700">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  </div>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-100 text-sm truncate">
                        {msg.sender?.name || msg.senderName || "Unknown Sender"}
                      </span>
                      {msg.sender?.handle && (
                        <span className="text-xs text-slate-400">@{msg.sender.handle}</span>
                      )}
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full font-medium border"
                        style={{
                          borderColor: `${meta.color}50`,
                          color: meta.color,
                          backgroundColor: `${meta.color}15`,
                        }}
                      >
                        {meta.name}
                      </span>
                    </div>

                    <span className="text-[11px] text-slate-500 font-mono">
                      {new Date(msg.receivedAt || msg.createdAt || Date.now()).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>

                  <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed">
                    {msg.text}
                  </p>

                  <div className="mt-2 flex items-center gap-3 text-[10px] text-slate-500">
                    <span>ID: <code className="font-mono text-slate-400">{msg.externalMessageId || msg.id}</code></span>
                    <span>•</span>
                    <span className="capitalize">Status: <span className="text-emerald-400 font-medium">{msg.status || "received"}</span></span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default UnifiedInbox;
