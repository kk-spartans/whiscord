import os from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { RuntimeSnapshot } from "./runtime-state";

const trim = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const serviceStatuses = new Set<string>([
  "disabled",
  "idle",
  "connecting",
  "connected",
  "closed",
  "error",
]);

const eventLevels = new Set<string>(["info", "warn", "error"]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function getNodeErrorCode(error: unknown): string | undefined {
  if (!isObjectRecord(error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

function isRuntimeSnapshot(value: unknown): value is RuntimeSnapshot {
  if (!isObjectRecord(value) || !isNumber(value.startedAt) || !Array.isArray(value.events)) {
    return false;
  }

  const config = value.config;
  const bridge = value.bridge;
  const discord = value.discord;
  const whatsapp = value.whatsapp;

  if (
    !isObjectRecord(config) ||
    !isStringArray(config.issues) ||
    !isStringArray(config.bridgeBlockers) ||
    typeof config.dataDir !== "string"
  ) {
    return false;
  }

  if (
    !isObjectRecord(bridge) ||
    typeof bridge.ready !== "boolean" ||
    !isNumber(bridge.discordToWhatsApp) ||
    !isNumber(bridge.whatsAppToDiscord) ||
    !isNumber(bridge.ignored) ||
    !isNumber(bridge.errors)
  ) {
    return false;
  }

  if (
    !isObjectRecord(discord) ||
    typeof discord.status !== "string" ||
    !serviceStatuses.has(discord.status) ||
    !isNumber(discord.guildCount)
  ) {
    return false;
  }

  if (
    !isObjectRecord(whatsapp) ||
    typeof whatsapp.status !== "string" ||
    !serviceStatuses.has(whatsapp.status) ||
    !Array.isArray(whatsapp.groups)
  ) {
    return false;
  }

  if (
    !whatsapp.groups.every(
      (group) =>
        isObjectRecord(group) &&
        typeof group.id === "string" &&
        typeof group.name === "string" &&
        isNumber(group.participants),
    )
  ) {
    return false;
  }

  return value.events.every(
    (event) =>
      isObjectRecord(event) &&
      isNumber(event.at) &&
      typeof event.level === "string" &&
      eventLevels.has(event.level) &&
      typeof event.message === "string",
  );
}

const configFileSchema = z.object({
  discord: z.object({
    token: z.string().min(1),
    channelId: z.string().regex(/^\d+$/, "must be a numeric Discord snowflake"),
  }),
  whatsapp: z.object({
    groupJid: z.string().regex(/@g\.us$/, "must end with @g.us"),
  }),
});

const partialConfigFileSchema = z.object({
  discord: z
    .object({
      token: z.string().optional(),
      channelId: z.string().optional(),
    })
    .optional(),
  whatsapp: z
    .object({
      groupJid: z.string().optional(),
    })
    .optional(),
});

export type StoredConfigFile = z.infer<typeof configFileSchema>;

export type StoredConfigInput = {
  discord: {
    token: string;
    channelId: string;
  };
  whatsapp: {
    groupJid: string;
  };
};

export type PartialStoredConfig = {
  discord?: {
    token?: string;
    channelId?: string;
  };
  whatsapp?: {
    groupJid?: string;
  };
};

export type AppPaths = {
  rootDir: string;
  dataDir: string;
  whatsappAuthDir: string;
  configFile: string;
  statusFile: string;
};

export type AppConfig = {
  paths: AppPaths;
  discord: {
    token?: string;
    channelId?: string;
  };
  whatsapp: {
    groupJid?: string;
  };
  issues: string[];
  bridgeBlockers: string[];
};

export function getAppPaths(
  rootDir = path.join(os.homedir(), ".local", "share", "whiscord"),
): AppPaths {
  const dataDir = rootDir;

  return {
    rootDir,
    dataDir,
    whatsappAuthDir: path.join(dataDir, "whatsapp-auth"),
    configFile: path.join(dataDir, "config.json"),
    statusFile: path.join(dataDir, "runtime-status.json"),
  };
}

export async function ensureDataDirectories(paths: AppPaths): Promise<void> {
  await mkdir(paths.dataDir, { recursive: true });
  await mkdir(paths.whatsappAuthDir, { recursive: true });
}

export async function loadConfig(paths = getAppPaths()): Promise<AppConfig> {
  await ensureDataDirectories(paths);

  let partial: PartialStoredConfig = {};
  const issues: string[] = [];

  try {
    const file = await readFile(paths.configFile, "utf8");
    const parsed = partialConfigFileSchema.safeParse(JSON.parse(file));
    if (parsed.success) {
      partial = parsed.data;
    } else {
      issues.push(`Config file is invalid: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
    }
  } catch (error) {
    if (getNodeErrorCode(error) !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(`Failed to read config file: ${message}`);
    }
  }

  const discordToken = trim(partial.discord?.token);
  const discordChannelId = trim(partial.discord?.channelId);
  const whatsappGroupJid = trim(partial.whatsapp?.groupJid);

  const bridgeBlockers = [
    !discordToken && "Discord token is not configured. Run `whiscord setup`.",
    !discordChannelId && "Discord channel ID is not configured. Run `whiscord setup`.",
    !whatsappGroupJid && "WhatsApp target group is not configured. Run `whiscord setup`.",
  ].filter((issue): issue is string => Boolean(issue));

  if (bridgeBlockers.length > 0 && issues.length === 0) {
    issues.push("Config file is missing required values");
  }

  return {
    paths,
    discord: {
      token: discordToken,
      channelId: discordChannelId,
    },
    whatsapp: {
      groupJid: whatsappGroupJid,
    },
    issues,
    bridgeBlockers,
  };
}

export async function saveConfig(
  paths: AppPaths,
  input: StoredConfigInput,
): Promise<StoredConfigFile> {
  await ensureDataDirectories(paths);

  const config = configFileSchema.parse({
    discord: {
      token: input.discord.token.trim(),
      channelId: input.discord.channelId.trim(),
    },
    whatsapp: {
      groupJid: input.whatsapp.groupJid.trim(),
    },
  });

  await writeFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

export async function writeRuntimeSnapshot(
  paths: AppPaths,
  snapshot: RuntimeSnapshot,
): Promise<void> {
  await ensureDataDirectories(paths);
  await writeFile(paths.statusFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export async function readRuntimeSnapshot(paths: AppPaths): Promise<RuntimeSnapshot | null> {
  try {
    const file = await readFile(paths.statusFile, "utf8");
    const parsed: unknown = JSON.parse(file);
    return isRuntimeSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
