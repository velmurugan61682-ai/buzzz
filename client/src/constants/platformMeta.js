export const PLATFORM_META = {
  gmail: { name: "Gmail", icon: "gmail", color: "#EA4335", channel: "Email" },
  instagram: { name: "Instagram", icon: "instagram", color: "#E1306C", channel: "Instagram" },
  instaxbot: { name: "InstaxBot", icon: "instaxbot", color: "#E1306C", channel: "Instagram" },
  linkedin: { name: "LinkedIn", icon: "linkedin", color: "#0A66C2", channel: "LinkedIn" },
  whatsapp: { name: "WhatsApp", icon: "whatsapp", color: "#25D366", channel: "WhatsApp" },
  youtube: { name: "YouTube", icon: "youtube", color: "#FF0000", channel: "YouTube" },
  channelbot: { name: "ChannelBot.in", icon: "channelbot", color: "#FF0000", channel: "YouTube" },
  telegram: { name: "Telegram", icon: "telegram", color: "#229ED9", channel: "Telegram" },
  facebook: { name: "Facebook", icon: "facebook", color: "#1877F2", channel: "Facebook" },
  custom_webhook: { name: "Custom Webhook", icon: "webhook", color: "#6366F1", channel: "Webhook" },
};

export const getPlatformMeta = (platform) => {
  if (!platform) return PLATFORM_META.gmail;
  const key = String(platform).toLowerCase().trim();
  if (key === "instaxbot" || key === "instaxbot.com") return PLATFORM_META.instaxbot;
  if (key === "instagram") return PLATFORM_META.instagram;
  if (key === "gowhats" || key === "whatsapp") return PLATFORM_META.whatsapp;
  if (key === "channelbot" || key === "channelbot.in") return PLATFORM_META.channelbot;
  if (key === "youtube") return PLATFORM_META.youtube;
  return PLATFORM_META[key] || PLATFORM_META.gmail;
};
