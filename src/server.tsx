import { type ReactNode, useEffect, useState } from "react";

import { Alert } from "@inkjs/ui";
import { Box, Text, render, type TextProps, useApp } from "ink";

import { BridgeService } from "./bridge";
import { type EventLevel, type RuntimeSnapshot, type ServiceStatus } from "./runtime-state";
import { loadConfig, type AppConfig, type AppPaths, writeRuntimeSnapshot } from "./config";

export async function runServer(paths: AppPaths): Promise<void> {
  const config = await loadConfig(paths);

  if (config.bridgeBlockers.length > 0) {
    for (const blocker of config.bridgeBlockers) {
      console.error(blocker);
    }
    console.error("Run `pnpm run setup` first.");
    return;
  }

  const instance = render(<ServerScreen config={config} paths={paths} />);
  await instance.waitUntilExit();
}

function ServerScreen({ config, paths }: { config: AppConfig; paths: AppPaths }) {
  const { exit } = useApp();
  const [bridge] = useState(() => new BridgeService(config));
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(() => bridge.getStore().getSnapshot());
  const [fatalError, setFatalError] = useState<string>();

  useEffect(() => {
    const store = bridge.getStore();
    const unsubscribe = store.subscribe((nextSnapshot) => {
      setSnapshot(nextSnapshot);
      void writeRuntimeSnapshot(paths, nextSnapshot);
    });

    let cleanedUp = false;

    const shutdown = () => {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);

      void bridge.stop().finally(() => {
        unsubscribe();
        exit();
      });
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    void bridge.start().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setFatalError(message);
    });

    return () => {
      shutdown();
    };
  }, [bridge, exit, paths]);

  return (
    <Box flexDirection="column" gap={1} paddingX={1} paddingY={1}>
      <Panel title="Whiscord server" accent="cyanBright">
        <Text>Bridge status for one Discord channel and one WhatsApp group.</Text>
        <Text dimColor>Local state: {paths.dataDir}</Text>
        <Text dimColor>Press Ctrl+C to stop.</Text>
      </Panel>

      {fatalError ? <Alert variant="error">{fatalError}</Alert> : null}
      {snapshot.config.issues.map((issue) => (
        <Alert key={issue} variant="warning">
          {issue}
        </Alert>
      ))}

      <Panel title="Bridge" accent={snapshot.bridge.ready ? "greenBright" : "yellowBright"}>
        <Line
          label="Ready"
          value={snapshot.bridge.ready ? "yes" : "not yet"}
          valueColor={snapshot.bridge.ready ? "greenBright" : "yellowBright"}
        />
        <Line label="Discord -> WhatsApp" value={String(snapshot.bridge.discordToWhatsApp)} />
        <Line label="WhatsApp -> Discord" value={String(snapshot.bridge.whatsAppToDiscord)} />
        <Line label="Ignored" value={String(snapshot.bridge.ignored)} />
        <Line
          label="Errors"
          value={String(snapshot.bridge.errors)}
          valueColor={snapshot.bridge.errors > 0 ? "redBright" : undefined}
        />
      </Panel>

      <Panel title="Discord" accent={statusColor(snapshot.discord.status)}>
        <Line
          label="Status"
          value={snapshot.discord.status}
          valueColor={statusColor(snapshot.discord.status)}
        />
        <Line label="User" value={snapshot.discord.user ?? "not connected"} />
        <Line label="Guilds" value={String(snapshot.discord.guildCount)} />
        <Line
          label="Channel"
          value={snapshot.discord.channelName ?? snapshot.discord.channelId ?? "missing"}
        />
        <Line
          label="Ping"
          value={snapshot.discord.pingMs ? `${snapshot.discord.pingMs} ms` : "-"}
        />
      </Panel>

      <Panel title="WhatsApp" accent={statusColor(snapshot.whatsapp.status)}>
        <Line
          label="Status"
          value={snapshot.whatsapp.status}
          valueColor={statusColor(snapshot.whatsapp.status)}
        />
        <Line label="Account" value={snapshot.whatsapp.user ?? "not connected"} />
        <Line
          label="Target group"
          value={snapshot.whatsapp.groupName ?? snapshot.whatsapp.groupJid ?? "missing"}
        />
        <Line label="Joined groups" value={String(snapshot.whatsapp.groups.length)} />
      </Panel>

      {snapshot.whatsapp.qrTerminal ? (
        <Panel title="Scan WhatsApp QR" accent="whiteBright">
          <Text>Open WhatsApp, go to Linked devices, and scan this QR.</Text>
          <Box marginTop={1}>
            <Text>{snapshot.whatsapp.qrTerminal}</Text>
          </Box>
        </Panel>
      ) : null}

      <Panel title="Recent events" accent="magentaBright">
        {snapshot.events.length === 0 ? (
          <Text dimColor>No events yet. The bridge is still warming up.</Text>
        ) : (
          snapshot.events.slice(0, 8).map((event) => (
            <Box key={`${event.at}-${event.message}`}>
              <Text color={eventColor(event.level)}>
                [{new Date(event.at).toLocaleTimeString()}]
              </Text>
              <Text> </Text>
              <Text color={eventColor(event.level)}>{event.level.toUpperCase()}</Text>
              <Text> {event.message}</Text>
            </Box>
          ))
        )}
      </Panel>
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

function Line({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: TextProps["color"];
}) {
  return (
    <Box>
      <Text color="gray">{label}:</Text>
      <Text> </Text>
      <Text color={valueColor}>{value}</Text>
    </Box>
  );
}

function statusColor(status: ServiceStatus) {
  switch (status) {
    case "connected": {
      return "greenBright";
    }

    case "connecting": {
      return "yellowBright";
    }

    case "error": {
      return "redBright";
    }

    case "closed": {
      return "magentaBright";
    }

    default: {
      return "gray";
    }
  }
}

function eventColor(level: EventLevel) {
  switch (level) {
    case "error": {
      return "redBright";
    }

    case "warn": {
      return "yellowBright";
    }

    default: {
      return "cyanBright";
    }
  }
}
