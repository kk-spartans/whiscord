import { mkdir } from "node:fs/promises";

import {
  Browsers,
  DisconnectReason,
  extractMessageContent,
  getContentType,
  makeWASocket,
  normalizeMessageContent,
  type ConnectionState,
  type Contact,
  type GroupMetadata,
  type WAMessage,
  type WASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { Client, Events, GatewayIntentBits, type Message, type SendableChannels } from "discord.js";
import pino from "pino";
import QRCode from "qrcode";

import type { AppConfig } from "./config";
import type { EventLevel, RuntimeEvent, RuntimeSnapshot } from "./runtime-state";

type SnapshotListener = (snapshot: RuntimeSnapshot) => void;

export class RuntimeStore {
  private snapshot: RuntimeSnapshot;
  private listeners = new Set<SnapshotListener>();

  constructor(config: AppConfig) {
    this.snapshot = {
      startedAt: Date.now(),
      config: {
        issues: [...config.issues],
        bridgeBlockers: [...config.bridgeBlockers],
        dataDir: config.paths.dataDir,
      },
      bridge: {
        ready: false,
        discordToWhatsApp: 0,
        whatsAppToDiscord: 0,
        ignored: 0,
        errors: 0,
      },
      discord: {
        status: config.discord.token ? "idle" : "disabled",
        guildCount: 0,
        channelId: config.discord.channelId,
      },
      whatsapp: {
        status: "idle",
        groupJid: config.whatsapp.groupJid,
        groups: [],
      },
      events: [],
    };
  }

  getSnapshot(): RuntimeSnapshot {
    return this.snapshot;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);

    return () => {
      this.listeners.delete(listener);
    };
  }

  setDiscord(patch: Partial<RuntimeSnapshot["discord"]>): void {
    this.snapshot = {
      ...this.snapshot,
      discord: {
        ...this.snapshot.discord,
        ...patch,
      },
    };
    this.emit();
  }

  setWhatsApp(patch: Partial<RuntimeSnapshot["whatsapp"]>): void {
    this.snapshot = {
      ...this.snapshot,
      whatsapp: {
        ...this.snapshot.whatsapp,
        ...patch,
      },
    };
    this.emit();
  }

  setBridge(patch: Partial<RuntimeSnapshot["bridge"]>): void {
    this.snapshot = {
      ...this.snapshot,
      bridge: {
        ...this.snapshot.bridge,
        ...patch,
      },
    };
    this.emit();
  }

  increment(direction: "discordToWhatsApp" | "whatsAppToDiscord" | "ignored" | "errors"): void {
    this.snapshot = {
      ...this.snapshot,
      bridge: {
        ...this.snapshot.bridge,
        [direction]: this.snapshot.bridge[direction] + 1,
      },
    };
    this.emit();
  }

  log(level: EventLevel, message: string): void {
    const event = {
      at: Date.now(),
      level,
      message,
    } satisfies RuntimeEvent;

    this.snapshot = {
      ...this.snapshot,
      events: [event, ...this.snapshot.events].slice(0, 40),
    };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }
}

export class BridgeService {
  private readonly logger = pino({ level: "silent" });
  private readonly contactMap = new Map<string, Contact>();
  private readonly groupCache = new Map<string, GroupMetadata>();
  private readonly store: RuntimeStore;

  private discordClient: Client | null = null;
  private discordChannel: SendableChannels | null = null;
  private whatsappSocket: WASocket | null = null;
  private whatsappReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private pairingRequested = false;

  constructor(
    private readonly config: AppConfig,
    store?: RuntimeStore,
  ) {
    this.store = store ?? new RuntimeStore(config);
  }

  getStore(): RuntimeStore {
    return this.store;
  }

  async start(): Promise<void> {
    await mkdir(this.config.paths.dataDir, { recursive: true });
    await mkdir(this.config.paths.whatsappAuthDir, { recursive: true });

    this.store.log("info", `Local state lives in ${this.config.paths.dataDir}`);

    await Promise.allSettled([this.startDiscord(), this.startWhatsApp()]);
    this.updateBridgeReady();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;

    if (this.whatsappReconnectTimer) {
      clearTimeout(this.whatsappReconnectTimer);
      this.whatsappReconnectTimer = null;
    }

    this.whatsappSocket?.end(undefined);
    this.whatsappSocket = null;

    if (this.discordClient) {
      await this.discordClient.destroy();
      this.discordClient = null;
    }
  }

  async refresh(): Promise<void> {
    await Promise.allSettled([
      this.resolveDiscordChannel(),
      this.refreshWhatsAppGroups(),
      this.resolveWhatsAppTargetGroup(),
    ]);
    this.updateBridgeReady();
  }

  private async startDiscord(): Promise<void> {
    const { token } = this.config.discord;
    if (!token) {
      this.store.log("warn", "Discord is disabled until DISCORD_TOKEN is set");
      this.store.setDiscord({ status: "disabled" });
      return;
    }

    this.store.setDiscord({ status: "connecting" });
    this.store.log("info", "Connecting to Discord");

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    client.once(Events.ClientReady, async (readyClient) => {
      this.store.setDiscord({
        status: "connected",
        user: readyClient.user.tag,
        guildCount: readyClient.guilds.cache.size,
        pingMs: readyClient.ws.ping,
      });
      this.store.log("info", `Discord ready as ${readyClient.user.tag}`);

      await this.resolveDiscordChannel();
      this.updateBridgeReady();
    });

    client.on(Events.MessageCreate, (message) => {
      void this.handleDiscordMessage(message);
    });

    client.on(Events.Warn, (warning) => {
      this.store.log("warn", `Discord warning: ${warning}`);
    });

    client.on(Events.Error, (error) => {
      this.store.increment("errors");
      this.store.setDiscord({ status: "error" });
      this.store.log("error", `Discord error: ${error.message}`);
      this.updateBridgeReady();
    });

    this.discordClient = client;
    await client.login(token);
  }

  private async resolveDiscordChannel(): Promise<void> {
    const channelId = this.config.discord.channelId;
    if (!this.discordClient?.isReady()) {
      return;
    }

    if (!channelId) {
      this.discordChannel = null;
      this.store.log("warn", "Discord bridge target is missing DISCORD_CHANNEL_ID");
      this.updateBridgeReady();
      return;
    }

    try {
      const channel = await this.discordClient.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        this.discordChannel = null;
        this.store.increment("errors");
        this.store.log("error", `Discord channel ${channelId} is missing or not text based`);
        this.updateBridgeReady();
        return;
      }

      this.discordChannel = channel as SendableChannels;

      const channelName =
        "name" in channel && typeof channel.name === "string" ? channel.name : channel.id;

      this.store.setDiscord({
        channelId,
        channelName,
        pingMs: this.discordClient.ws.ping,
      });
      this.store.log("info", `Discord target channel ready: ${channelName}`);
      this.updateBridgeReady();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.discordChannel = null;
      this.store.increment("errors");
      this.store.log("error", `Failed to resolve Discord channel: ${message}`);
      this.updateBridgeReady();
    }
  }

  private async startWhatsApp(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.store.setWhatsApp({ status: "connecting" });
    this.store.log("info", "Connecting to WhatsApp");

    const auth = await useMultiFileAuthState(this.config.paths.whatsappAuthDir);
    const socket = makeWASocket({
      auth: auth.state,
      browser: Browsers.macOS("Desktop"),
      cachedGroupMetadata: async (jid) => this.groupCache.get(jid),
      getMessage: async () => undefined,
      logger: this.logger,
      markOnlineOnConnect: false,
    });

    this.whatsappSocket = socket;
    this.pairingRequested = false;

    socket.ev.on("creds.update", () => {
      void auth.saveCreds();
    });

    socket.ev.on("connection.update", (update) => {
      void this.handleWhatsAppConnectionUpdate(socket, update);
    });

    socket.ev.on("messages.upsert", (payload) => {
      void this.handleWhatsAppMessages(payload.messages, payload.type);
    });

    socket.ev.on("contacts.upsert", (contacts) => {
      this.upsertContacts(contacts);
    });

    socket.ev.on("contacts.update", (contacts) => {
      this.upsertContacts(contacts);
    });

    socket.ev.on("groups.upsert", () => {
      void this.refreshWhatsAppGroups();
    });

    socket.ev.on("groups.update", () => {
      void this.refreshWhatsAppGroups();
    });
  }

  private async handleWhatsAppConnectionUpdate(
    socket: WASocket,
    update: Partial<ConnectionState>,
  ): Promise<void> {
    if (socket !== this.whatsappSocket) {
      return;
    }

    if (update.connection === "connecting") {
      this.store.setWhatsApp({ status: "connecting" });
    }

    if (update.qr) {
      const qrTerminal = await QRCode.toString(update.qr, {
        small: true,
        type: "terminal",
      });

      this.store.setWhatsApp({ qrTerminal });
      this.store.log("info", "WhatsApp QR updated");
    }

    if (
      this.config.whatsapp.pairingPhone &&
      !this.pairingRequested &&
      !socket.authState.creds.registered &&
      (update.connection === "connecting" || Boolean(update.qr))
    ) {
      this.pairingRequested = true;

      try {
        const pairingCode = await socket.requestPairingCode(this.config.whatsapp.pairingPhone);
        this.store.setWhatsApp({ pairingCode, qrTerminal: undefined });
        this.store.log("info", "WhatsApp pairing code requested");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.increment("errors");
        this.store.log("error", `Failed to request WhatsApp pairing code: ${message}`);
      }
    }

    if (update.connection === "open") {
      this.store.setWhatsApp({
        status: "connected",
        user: this.getWhatsAppAccountLabel(socket.user),
      });
      this.store.log("info", "WhatsApp connected");

      await this.refreshWhatsAppGroups();
      await this.resolveWhatsAppTargetGroup();
      this.updateBridgeReady();
      return;
    }

    if (update.connection !== "close") {
      return;
    }

    this.whatsappSocket = null;
    const statusCode = (
      update.lastDisconnect?.error as {
        output?: {
          statusCode?: number;
        };
      }
    )?.output?.statusCode;

    if (statusCode === DisconnectReason.loggedOut) {
      this.store.setWhatsApp({ status: "error" });
      this.store.increment("errors");
      this.store.log("error", "WhatsApp logged out. Delete data/whatsapp-auth and pair again.");
      this.updateBridgeReady();
      return;
    }

    this.store.setWhatsApp({ status: "closed" });
    this.store.log("warn", "WhatsApp disconnected, retrying shortly");
    this.updateBridgeReady();

    if (this.stopped) {
      return;
    }

    if (this.whatsappReconnectTimer) {
      clearTimeout(this.whatsappReconnectTimer);
    }

    this.whatsappReconnectTimer = setTimeout(() => {
      void this.startWhatsApp();
    }, 1_500);
  }

  private async refreshWhatsAppGroups(): Promise<void> {
    if (!this.whatsappSocket) {
      return;
    }

    try {
      const groups = await this.whatsappSocket.groupFetchAllParticipating();
      const summaries = Object.values(groups)
        .map((group) => ({
          id: group.id,
          name: group.subject || group.id,
          participants: group.participants.length,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

      for (const group of Object.values(groups)) {
        this.groupCache.set(group.id, group);
      }

      this.store.setWhatsApp({ groups: summaries });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.increment("errors");
      this.store.log("error", `Failed to refresh WhatsApp groups: ${message}`);
    }
  }

  private async resolveWhatsAppTargetGroup(): Promise<void> {
    const groupJid = this.config.whatsapp.groupJid;
    if (!groupJid || !this.whatsappSocket) {
      if (!groupJid) {
        this.store.log("warn", "WhatsApp bridge target is missing WHATSAPP_GROUP_JID");
      }
      this.updateBridgeReady();
      return;
    }

    try {
      const cachedGroup =
        this.groupCache.get(groupJid) ?? (await this.whatsappSocket.groupMetadata(groupJid));
      this.groupCache.set(groupJid, cachedGroup);
      this.store.setWhatsApp({
        groupJid,
        groupName: cachedGroup.subject || cachedGroup.id,
      });
      this.store.log(
        "info",
        `WhatsApp target group ready: ${cachedGroup.subject || cachedGroup.id}`,
      );
      this.updateBridgeReady();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.increment("errors");
      this.store.log("error", `Failed to resolve WhatsApp target group: ${message}`);
      this.updateBridgeReady();
    }
  }

  private async handleDiscordMessage(message: Message): Promise<void> {
    if (message.author.bot) {
      return;
    }

    if (!this.whatsappSocket || !this.config.whatsapp.groupJid) {
      return;
    }

    if (message.channelId !== this.config.discord.channelId) {
      return;
    }

    const body = this.getDiscordMessageBody(message);
    if (!body) {
      this.store.increment("ignored");
      return;
    }

    const sender =
      message.member?.displayName ?? message.author.globalName ?? message.author.username;
    const chunks = splitLabeledMessage("Discord", sender, body, 3_500);

    try {
      for (const chunk of chunks) {
        await this.whatsappSocket.sendMessage(this.config.whatsapp.groupJid, { text: chunk });
      }

      this.store.increment("discordToWhatsApp");
      this.store.log("info", `Discord -> WhatsApp from ${sender}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.store.increment("errors");
      this.store.log("error", `Failed to forward Discord message: ${errorMessage}`);
    }
  }

  private async handleWhatsAppMessages(messages: WAMessage[], type: string): Promise<void> {
    if (type !== "notify") {
      return;
    }

    for (const message of messages) {
      if (message.key.fromMe) {
        continue;
      }

      if (!this.discordChannel || message.key.remoteJid !== this.config.whatsapp.groupJid) {
        continue;
      }

      const body = this.getWhatsAppMessageBody(message);
      if (!body) {
        this.store.increment("ignored");
        continue;
      }

      const sender = this.getWhatsAppSenderLabel(message);
      const chunks = splitLabeledMessage("WhatsApp", sender, body, 2_000);

      try {
        for (const chunk of chunks) {
          await this.discordChannel.send({
            allowedMentions: { parse: [] },
            content: chunk,
          });
        }

        this.store.increment("whatsAppToDiscord");
        this.store.log("info", `WhatsApp -> Discord from ${sender}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.store.increment("errors");
        this.store.log("error", `Failed to forward WhatsApp message: ${errorMessage}`);
      }
    }
  }

  private getDiscordMessageBody(message: Message): string | undefined {
    const parts: string[] = [];
    const text = message.cleanContent.trim();

    if (text) {
      parts.push(text);
    }

    for (const attachment of message.attachments.values()) {
      const name = attachment.name ?? "attachment";
      parts.push(`[Attachment] ${name}: ${attachment.url}`);
    }

    for (const sticker of message.stickers.values()) {
      parts.push(`[Sticker] ${sticker.name ?? sticker.id}`);
    }

    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  private getWhatsAppMessageBody(message: WAMessage): string | undefined {
    const content = extractMessageContent(normalizeMessageContent(message.message));
    if (!content) {
      return undefined;
    }

    const contentType = getContentType(content);
    switch (contentType) {
      case "conversation": {
        return content.conversation?.trim() || undefined;
      }

      case "extendedTextMessage": {
        return content.extendedTextMessage?.text?.trim() || undefined;
      }

      case "imageMessage": {
        return formatWhatsAppMedia("Image", content.imageMessage?.caption);
      }

      case "videoMessage": {
        return formatWhatsAppMedia("Video", content.videoMessage?.caption);
      }

      case "documentMessage": {
        return formatWhatsAppMedia(
          "Document",
          content.documentMessage?.fileName ?? content.documentMessage?.caption,
        );
      }

      case "audioMessage": {
        return "[Voice message]";
      }

      case "stickerMessage": {
        return "[Sticker]";
      }

      case "contactMessage": {
        return `[Contact] ${content.contactMessage?.displayName ?? "Shared contact"}`;
      }

      case "locationMessage": {
        return "[Location]";
      }

      case "liveLocationMessage": {
        return "[Live location]";
      }

      default: {
        return undefined;
      }
    }
  }

  private getWhatsAppSenderLabel(message: WAMessage): string {
    const senderJid = message.key.participant ?? message.key.remoteJid ?? "unknown";
    const contact = this.contactMap.get(senderJid);
    const phone = jidToPhoneNumber(senderJid);

    return message.pushName ?? contact?.notify ?? contact?.name ?? contact?.verifiedName ?? phone;
  }

  private getWhatsAppAccountLabel(account?: Contact): string | undefined {
    if (!account) {
      return undefined;
    }

    return account.name ?? account.notify ?? account.verifiedName ?? jidToPhoneNumber(account.id);
  }

  private upsertContacts(contacts: Array<Partial<Contact>>): void {
    for (const contact of contacts) {
      const current = contact.id ? this.contactMap.get(contact.id) : undefined;
      if (!contact.id) {
        continue;
      }

      this.contactMap.set(contact.id, {
        id: contact.id,
        ...current,
        ...contact,
      });
    }
  }

  private updateBridgeReady(): void {
    const discordReady =
      this.store.getSnapshot().discord.status === "connected" && Boolean(this.discordChannel);
    const whatsappSnapshot = this.store.getSnapshot().whatsapp;
    const whatsappReady =
      whatsappSnapshot.status === "connected" &&
      Boolean(this.whatsappSocket) &&
      Boolean(this.config.whatsapp.groupJid) &&
      Boolean(whatsappSnapshot.groupName);

    this.store.setBridge({ ready: discordReady && whatsappReady });
  }
}

function splitLabeledMessage(
  source: "Discord" | "WhatsApp",
  sender: string,
  body: string,
  maxLength: number,
): string[] {
  const firstPrefix = `[${source}] ${sender}\n`;
  const nextPrefix = `[${source}] ${sender} (cont.)\n`;

  return splitByLength(body, maxLength, firstPrefix, nextPrefix).map(
    (chunk, index) => `${index === 0 ? firstPrefix : nextPrefix}${chunk}`,
  );
}

function splitByLength(
  text: string,
  maxLength: number,
  firstPrefix: string,
  nextPrefix: string,
): string[] {
  const parts: string[] = [];
  let remaining = text.trim();
  let currentMax = Math.max(32, maxLength - firstPrefix.length);

  while (remaining.length > currentMax) {
    let breakIndex = remaining.lastIndexOf("\n", currentMax);
    if (breakIndex < currentMax / 2) {
      breakIndex = remaining.lastIndexOf(" ", currentMax);
    }
    if (breakIndex < 1) {
      breakIndex = currentMax;
    }

    parts.push(remaining.slice(0, breakIndex).trim());
    remaining = remaining.slice(breakIndex).trim();
    currentMax = Math.max(32, maxLength - nextPrefix.length);
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts;
}

function formatWhatsAppMedia(label: string, caption?: string | null): string {
  const trimmedCaption = caption?.trim();
  return trimmedCaption ? `[${label}] ${trimmedCaption}` : `[${label}]`;
}

function jidToPhoneNumber(jid: string): string {
  const base = jid.split("@")[0]?.split(":")[0] ?? jid;
  return base.replace(/\D+/g, "") || base;
}
