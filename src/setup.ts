import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  Browsers,
  DisconnectReason,
  makeWASocket,
  type ConnectionState,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { Client, GatewayIntentBits } from "discord.js";
import pino from "pino";
import QRCode from "qrcode";

import {
  ensureDataDirectories,
  loadConfig,
  saveConfig,
  type AppPaths,
  type StoredConfigInput,
} from "./config";

type SetupGroup = {
  id: string;
  name: string;
  participants: number;
};

export async function runSetup(paths: AppPaths): Promise<void> {
  await ensureDataDirectories(paths);

  const current = await loadConfig(paths);
  const rl = createInterface({ input, output });

  try {
    output.write("Whiscord setup\n\n");
    output.write(`Config will be stored in ${paths.configFile}\n`);
    output.write(`WhatsApp auth will be stored in ${paths.whatsappAuthDir}\n\n`);

    const discordToken = await promptRequired(rl, "Discord bot token", current.discord.token);
    const discordChannelId = await promptRegex(
      rl,
      "Discord channel ID",
      /^\d+$/,
      "Must be digits only",
      current.discord.channelId,
    );
    const pairingPhone = await promptOptional(
      rl,
      "WhatsApp pairing phone (digits only, optional)",
      current.whatsapp.pairingPhone,
    );

    output.write("\nValidating Discord config...\n");
    const discordChannelName = await validateDiscord(discordToken, discordChannelId);
    output.write(`Discord target looks good: ${discordChannelName}\n\n`);

    output.write("Logging into WhatsApp so you can pick a target group...\n");
    const groups = await fetchWhatsAppGroups(paths, pairingPhone);
    if (groups.length === 0) {
      throw new Error("No WhatsApp groups were found on this account");
    }

    const selectedGroup = await promptForGroup(rl, groups, current.whatsapp.groupJid);

    const config: StoredConfigInput = {
      discord: {
        token: discordToken,
        channelId: discordChannelId,
      },
      whatsapp: {
        groupJid: selectedGroup.id,
        pairingPhone,
      },
    };

    await saveConfig(paths, config);

    output.write("\nSaved config:\n");
    output.write(`- Discord channel: ${discordChannelName}\n`);
    output.write(`- WhatsApp group: ${selectedGroup.name}\n`);
    output.write(`- Config file: ${paths.configFile}\n\n`);
    output.write("Next: run `whiscord server`.\n");
  } finally {
    rl.close();
  }
}

async function validateDiscord(token: string, channelId: string): Promise<string> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  try {
    await client.login(token);
    const channel = await client.channels.fetch(channelId);

    if (!channel || !channel.isTextBased()) {
      throw new Error("Configured channel is missing or not text-based");
    }

    return "name" in channel && typeof channel.name === "string" ? channel.name : channel.id;
  } finally {
    await client.destroy();
  }
}

async function fetchWhatsAppGroups(paths: AppPaths, pairingPhone?: string): Promise<SetupGroup[]> {
  const auth = await useMultiFileAuthState(paths.whatsappAuthDir);
  const socket = makeWASocket({
    auth: auth.state,
    browser: Browsers.macOS("Desktop"),
    getMessage: async () => undefined,
    logger: pino({ level: "silent" }),
    markOnlineOnConnect: false,
  });

  socket.ev.on("creds.update", () => {
    void auth.saveCreds();
  });

  let pairingRequested = false;

  try {
    await new Promise<void>((resolve, reject) => {
      const onUpdate = async (update: Partial<ConnectionState>) => {
        if (update.qr) {
          const qrTerminal = await QRCode.toString(update.qr, {
            small: true,
            type: "terminal",
          });
          output.write(`${qrTerminal}\n`);
        }

        if (
          pairingPhone &&
          !pairingRequested &&
          !socket.authState.creds.registered &&
          (update.connection === "connecting" || Boolean(update.qr))
        ) {
          pairingRequested = true;
          const code = await socket.requestPairingCode(pairingPhone);
          output.write(`Pairing code: ${code}\n`);
        }

        if (update.connection === "open") {
          resolve();
          return;
        }

        if (update.connection === "close") {
          const statusCode = (
            update.lastDisconnect?.error as {
              output?: {
                statusCode?: number;
              };
            }
          )?.output?.statusCode;

          if (statusCode === DisconnectReason.loggedOut) {
            reject(
              new Error("WhatsApp logged out. Delete data/whatsapp-auth and run setup again."),
            );
            return;
          }

          reject(new Error("WhatsApp connection closed before setup completed"));
        }
      };

      socket.ev.on("connection.update", (update) => {
        void onUpdate(update);
      });
    });

    const groups = await socket.groupFetchAllParticipating();

    return Object.values(groups)
      .map((group) => ({
        id: group.id,
        name: group.subject || group.id,
        participants: group.participants.length,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } finally {
    socket.end(undefined);
  }
}

async function promptForGroup(
  rl: ReturnType<typeof createInterface>,
  groups: SetupGroup[],
  defaultGroupJid?: string,
): Promise<SetupGroup> {
  output.write("\nAvailable WhatsApp groups:\n");

  let defaultIndex = -1;
  groups.forEach((group, index) => {
    const isDefault = group.id === defaultGroupJid;
    if (isDefault) {
      defaultIndex = index;
    }

    output.write(
      `${index + 1}. ${group.name} (${group.participants})${isDefault ? " [current]" : ""}\n`,
    );
  });

  while (true) {
    const answer = await rl.question(
      `Choose target group${defaultIndex >= 0 ? ` [${defaultIndex + 1}]` : ""}: `,
    );
    const normalized = answer.trim();

    if (!normalized && defaultIndex >= 0) {
      const selected = groups[defaultIndex];
      if (selected) {
        return selected;
      }
    }

    const index = Number.parseInt(normalized, 10);
    if (Number.isInteger(index) && index >= 1 && index <= groups.length) {
      const selected = groups[index - 1];
      if (selected) {
        return selected;
      }
    }

    output.write("Pick one of the listed numbers. Computers are picky.\n");
  }
}

async function promptRequired(
  rl: ReturnType<typeof createInterface>,
  label: string,
  current?: string,
): Promise<string> {
  while (true) {
    const value = await rl.question(`${label}${current ? " [saved]" : ""}: `);
    const normalized = value.trim() || current?.trim();
    if (normalized) {
      return normalized;
    }

    output.write("This one is required. No sneaky blank input.\n");
  }
}

async function promptRegex(
  rl: ReturnType<typeof createInterface>,
  label: string,
  pattern: RegExp,
  errorMessage: string,
  current?: string,
): Promise<string> {
  while (true) {
    const value = await promptRequired(rl, label, current);
    if (pattern.test(value)) {
      return value;
    }

    output.write(`${errorMessage}\n`);
  }
}

async function promptOptional(
  rl: ReturnType<typeof createInterface>,
  label: string,
  current?: string,
): Promise<string | undefined> {
  while (true) {
    const answer = await rl.question(`${label}${current ? ` [${current}]` : ""}: `);
    const normalized = answer.trim();
    if (!normalized) {
      return current?.trim() || undefined;
    }

    if (/^\d+$/.test(normalized)) {
      return normalized;
    }

    output.write("Digits only. No plus sign, no spaces, no clownery.\n");
  }
}
