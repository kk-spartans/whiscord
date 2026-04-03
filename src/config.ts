import os from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { RuntimeSnapshot } from "./runtime-state";

const trim = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const configFileSchema = z.object({
  discord: z.object({
    token: z.string().min(1),
    channelId: z.string().regex(/^\d+$/, "must be a numeric Discord snowflake"),
  }),
  whatsapp: z.object({
    groupJid: z.string().regex(/@g\.us$/, "must end with @g.us"),
    pairingPhone: z.string().regex(/^\d+$/, "must be digits only, no leading plus").optional(),
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
      pairingPhone: z.string().optional(),
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
    pairingPhone?: string;
  };
};

export type PartialStoredConfig = {
  discord?: {
    token?: string;
    channelId?: string;
  };
  whatsapp?: {
    groupJid?: string;
    pairingPhone?: string;
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
    pairingPhone?: string;
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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(`Failed to read config file: ${message}`);
    }
  }

  const discordToken = trim(partial.discord?.token);
  const discordChannelId = trim(partial.discord?.channelId);
  const whatsappGroupJid = trim(partial.whatsapp?.groupJid);
  const whatsappPairingPhone = trim(partial.whatsapp?.pairingPhone);

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
      pairingPhone: whatsappPairingPhone,
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
      pairingPhone: trim(input.whatsapp.pairingPhone),
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
    return JSON.parse(file) as RuntimeSnapshot;
  } catch {
    return null;
  }
}
