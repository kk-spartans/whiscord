export type EventLevel = "info" | "warn" | "error";
export type ServiceStatus = "disabled" | "idle" | "connecting" | "connected" | "closed" | "error";

export type RuntimeEvent = {
  at: number;
  level: EventLevel;
  message: string;
};

export type GroupSummary = {
  id: string;
  name: string;
  participants: number;
};

export type RuntimeSnapshot = {
  startedAt: number;
  config: {
    issues: string[];
    bridgeBlockers: string[];
    dataDir: string;
  };
  bridge: {
    ready: boolean;
    discordToWhatsApp: number;
    whatsAppToDiscord: number;
    ignored: number;
    errors: number;
  };
  discord: {
    status: ServiceStatus;
    user?: string;
    guildCount: number;
    pingMs?: number;
    channelId?: string;
    channelName?: string;
  };
  whatsapp: {
    status: ServiceStatus;
    user?: string;
    pairingCode?: string;
    qrTerminal?: string;
    groupJid?: string;
    groupName?: string;
    groups: GroupSummary[];
  };
  events: RuntimeEvent[];
};

export function createPlaceholderSnapshot(dataDir: string): RuntimeSnapshot {
  return {
    startedAt: Date.now(),
    config: {
      issues: [],
      bridgeBlockers: ["Headless server has not written a status file yet"],
      dataDir,
    },
    bridge: {
      ready: false,
      discordToWhatsApp: 0,
      whatsAppToDiscord: 0,
      ignored: 0,
      errors: 0,
    },
    discord: {
      status: "idle",
      guildCount: 0,
    },
    whatsapp: {
      status: "idle",
      groups: [],
    },
    events: [],
  };
}
