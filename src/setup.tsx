import { type ReactNode, useEffect, useState } from "react";

import { Alert, PasswordInput, Select, Spinner, StatusMessage, TextInput } from "@inkjs/ui";
import {
  Browsers,
  DisconnectReason,
  makeWASocket,
  type ConnectionState,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { Box, Text, render, type TextProps, useApp, useInput } from "ink";
import { Client, GatewayIntentBits } from "discord.js";
import pino from "pino";

import {
  ensureDataDirectories,
  loadConfig,
  saveConfig,
  type AppPaths,
  type AppConfig,
  type StoredConfigInput,
} from "./config";
import { renderWhatsAppQr } from "./whatsapp-qr";

type SetupGroup = {
  id: string;
  name: string;
  participants: number;
};

type SetupStep =
  | "discord-token"
  | "discord-channel"
  | "validating-discord"
  | "pair-whatsapp"
  | "pick-group"
  | "saving"
  | "done"
  | "error";

type WhatsAppPairingState = {
  status: string;
  qrTerminal?: string;
};

export async function runSetup(paths: AppPaths): Promise<void> {
  await ensureDataDirectories(paths);

  const current = await loadConfig(paths);
  let success = true;
  const instance = render(
    <SetupScreen
      current={current}
      paths={paths}
      onExit={(nextSuccess) => {
        success = nextSuccess;
      }}
    />,
  );

  await instance.waitUntilExit();

  if (!success) {
    process.exitCode = 1;
  }
}

function SetupScreen({
  current,
  paths,
  onExit,
}: {
  current: AppConfig;
  paths: AppPaths;
  onExit: (success: boolean) => void;
}) {
  const { exit } = useApp();
  const [step, setStep] = useState<SetupStep>("discord-token");
  const [discordToken, setDiscordToken] = useState(current.discord.token ?? "");
  const [discordChannelId, setDiscordChannelId] = useState(current.discord.channelId ?? "");
  const [discordChannelName, setDiscordChannelName] = useState<string>();
  const [groups, setGroups] = useState<SetupGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState(current.whatsapp.groupJid);
  const [pairingState, setPairingState] = useState<WhatsAppPairingState>({
    status: "Waiting for WhatsApp login to start...",
  });
  const [errorMessage, setErrorMessage] = useState<string>();

  useInput((_input, key) => {
    if ((step === "done" || step === "error") && (key.return || key.escape)) {
      onExit(step === "done");
      exit();
    }
  });

  useEffect(() => {
    if (step !== "validating-discord") {
      return;
    }

    let cancelled = false;
    setErrorMessage(undefined);

    void (async () => {
      try {
        const channelName = await validateDiscord(discordToken, discordChannelId);
        if (cancelled) {
          return;
        }

        setDiscordChannelName(channelName);
        setStep("pair-whatsapp");
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message);
        setStep("discord-channel");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [discordChannelId, discordToken, step]);

  useEffect(() => {
    if (step !== "pair-whatsapp") {
      return;
    }

    let cancelled = false;
    setErrorMessage(undefined);
    setPairingState({
      status: "Waiting for WhatsApp to hand over a QR...",
    });

    void (async () => {
      try {
        const nextGroups = await fetchWhatsAppGroups(paths, (nextState) => {
          if (!cancelled) {
            setPairingState(nextState);
          }
        });

        if (cancelled) {
          return;
        }

        if (nextGroups.length === 0) {
          throw new Error("No WhatsApp groups were found on this account");
        }

        setGroups(nextGroups);
        setSelectedGroupId((currentGroupId) => {
          if (currentGroupId && nextGroups.some((group) => group.id === currentGroupId)) {
            return currentGroupId;
          }

          return nextGroups[0]?.id;
        });
        setStep("pick-group");
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message);
        setStep("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [paths, step]);

  useEffect(() => {
    if (step !== "saving") {
      return;
    }

    const selectedGroup = groups.find((group) => group.id === selectedGroupId);
    if (!selectedGroup) {
      setErrorMessage("Pick a WhatsApp group before saving. The app is not psychic.");
      setStep("pick-group");
      return;
    }

    let cancelled = false;
    setErrorMessage(undefined);

    void (async () => {
      try {
        const config: StoredConfigInput = {
          discord: {
            token: discordToken,
            channelId: discordChannelId,
          },
          whatsapp: {
            groupJid: selectedGroup.id,
          },
        };

        await saveConfig(paths, config);
        if (!cancelled) {
          setStep("done");
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message);
        setStep("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [discordChannelId, discordToken, groups, paths, selectedGroupId, step]);

  const selectedGroup = groups.find((group) => group.id === selectedGroupId);

  return (
    <Box flexDirection="column" gap={1} paddingX={1} paddingY={1}>
      <Panel title="Whiscord setup" accent="cyanBright">
        <Text>Discord token, channel, WhatsApp QR, then group pick. No phone number clownery.</Text>
        <Text dimColor>Config: {paths.configFile}</Text>
        <Text dimColor>WhatsApp auth: {paths.whatsappAuthDir}</Text>
      </Panel>

      {(errorMessage || current.issues[0]) && step !== "done" ? (
        <Alert variant="warning">{errorMessage ?? current.issues[0]}</Alert>
      ) : null}

      {(step === "discord-token" ||
        step === "discord-channel" ||
        step === "validating-discord" ||
        step === "pair-whatsapp" ||
        step === "pick-group" ||
        step === "saving" ||
        step === "done") && (
        <Panel title="Progress" accent="blueBright">
          <Text color={stepColor(step === "discord-token" ? "active" : "done")}>
            1. Discord token
          </Text>
          <Text
            color={stepColor(
              step === "discord-channel" || step === "validating-discord"
                ? "active"
                : discordChannelId
                  ? "done"
                  : "pending",
            )}
          >
            2. Discord channel
          </Text>
          <Text
            color={stepColor(
              step === "pair-whatsapp" ? "active" : groups.length > 0 ? "done" : "pending",
            )}
          >
            3. WhatsApp login
          </Text>
          <Text
            color={stepColor(
              step === "pick-group" || step === "saving" || step === "done" ? "active" : "pending",
            )}
          >
            4. WhatsApp group
          </Text>
        </Panel>
      )}

      {step === "discord-token" ? (
        <Panel title="Discord bot token" accent="magentaBright">
          <StatusMessage variant="info">
            {current.discord.token
              ? "Press Enter to keep the saved token, or paste a new one."
              : "Paste the Discord bot token and press Enter."}
          </StatusMessage>
          <Box marginTop={1}>
            <PasswordInput
              key="discord-token"
              placeholder={
                current.discord.token ? "Saved token is ready to reuse" : "Discord bot token"
              }
              onSubmit={(value) => {
                const nextToken = value.trim() || current.discord.token?.trim();
                if (!nextToken) {
                  setErrorMessage("Discord bot token is required.");
                  return;
                }

                setErrorMessage(undefined);
                setDiscordToken(nextToken);
                setStep("discord-channel");
              }}
            />
          </Box>
        </Panel>
      ) : null}

      {step === "discord-channel" ? (
        <Panel title="Discord channel ID" accent="yellowBright">
          <StatusMessage variant="info">
            Enter the target channel snowflake. Digits only. Tiny database IDs pretending to be
            majestic.
          </StatusMessage>
          <Box marginTop={1}>
            <TextInput
              key="discord-channel"
              defaultValue={current.discord.channelId}
              placeholder="Discord channel ID"
              onSubmit={(value) => {
                const nextChannelId = value.trim() || current.discord.channelId?.trim();
                if (!nextChannelId) {
                  setErrorMessage("Discord channel ID is required.");
                  return;
                }

                if (!/^\d+$/.test(nextChannelId)) {
                  setErrorMessage("Discord channel ID must be digits only.");
                  return;
                }

                setErrorMessage(undefined);
                setDiscordChannelId(nextChannelId);
                setStep("validating-discord");
              }}
            />
          </Box>
        </Panel>
      ) : null}

      {step === "validating-discord" ? (
        <Panel title="Checking Discord" accent="greenBright">
          <Spinner label="Logging in and verifying the target channel..." />
        </Panel>
      ) : null}

      {step === "pair-whatsapp" ? (
        <>
          <Panel title="Pair WhatsApp" accent="greenBright">
            <StatusMessage variant="info">
              Open WhatsApp on your phone, go to Linked devices, then scan this QR.
            </StatusMessage>
            <Box marginTop={1}>
              <Text>{pairingState.status}</Text>
            </Box>
          </Panel>

          <Panel title="Scan QR" accent="whiteBright">
            <Text>{pairingState.qrTerminal ?? "Waiting for a fresh QR..."}</Text>
          </Panel>
        </>
      ) : null}

      {step === "pick-group" ? (
        <Panel title="Choose WhatsApp group" accent="cyanBright">
          <StatusMessage variant="info">
            Use arrow keys, then Enter. This is the group the bridge reads from and writes to.
          </StatusMessage>
          <Box marginTop={1}>
            <Select
              key="whatsapp-group"
              defaultValue={selectedGroupId}
              visibleOptionCount={Math.min(groups.length, 8)}
              options={groups.map((group) => ({
                label: `${group.name} (${group.participants})${group.id === current.whatsapp.groupJid ? " [current]" : ""}`,
                value: group.id,
              }))}
              onChange={(value) => {
                setSelectedGroupId(value);
                setStep("saving");
              }}
            />
          </Box>
        </Panel>
      ) : null}

      {step === "saving" ? (
        <Panel title="Saving config" accent="magentaBright">
          <Spinner label="Writing config and locking in the selected WhatsApp group..." />
        </Panel>
      ) : null}

      {step === "done" ? (
        <Panel title="Setup complete" accent="greenBright">
          <Alert variant="success">Everything is wired. Press Enter to close this wizard.</Alert>
          <Box flexDirection="column" marginTop={1}>
            <Text>Discord channel: {discordChannelName ?? discordChannelId}</Text>
            <Text>WhatsApp group: {selectedGroup?.name ?? selectedGroupId}</Text>
            <Text dimColor>Next: `bun run server`</Text>
          </Box>
        </Panel>
      ) : null}

      {step === "error" ? (
        <Panel title="Setup failed" accent="redBright">
          <Alert variant="error">
            {errorMessage ?? "Setup crashed in a deeply unhelpful way."}
          </Alert>
          <Box marginTop={1} flexDirection="column">
            <Text>Press Enter to exit.</Text>
            <Text dimColor>Nothing gets saved unless the final step succeeds.</Text>
          </Box>
        </Panel>
      ) : null}

      <Text dimColor>Ctrl+C also works if you hate commitment.</Text>
    </Box>
  );
}

function Panel({
  title,
  accent,
  children,
}: {
  title: string;
  accent: TextProps["color"];
  children: ReactNode;
}) {
  return (
    <Box borderStyle="round" borderColor={accent} flexDirection="column" paddingX={1} paddingY={0}>
      <Text color={accent}>{title}</Text>
      <Box marginTop={1} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}

function stepColor(state: "done" | "active" | "pending") {
  switch (state) {
    case "done": {
      return "greenBright";
    }

    case "active": {
      return "cyanBright";
    }

    default: {
      return "gray";
    }
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

async function fetchWhatsAppGroups(
  paths: AppPaths,
  onState: (state: WhatsAppPairingState) => void,
): Promise<SetupGroup[]> {
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

  try {
    await new Promise<void>((resolve, reject) => {
      const onUpdate = async (update: Partial<ConnectionState>) => {
        if (update.connection === "connecting") {
          onState({
            status: "Connecting to WhatsApp...",
          });
        }

        if (update.qr) {
          onState({
            status: "QR ready. Scan it from WhatsApp > Linked devices.",
            qrTerminal: await renderWhatsAppQr(update.qr),
          });
        }

        if (update.connection === "open") {
          onState({
            status: "WhatsApp connected. Loading your groups...",
          });
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
