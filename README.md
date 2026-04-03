# whiscord

Headless bridge for one Discord channel and one WhatsApp group.

## What it does

- Forwards Discord messages into WhatsApp with the Discord sender attached
- Forwards WhatsApp messages into Discord with the WhatsApp sender attached
- Prefers WhatsApp `pushName`/display name, then saved contact name, then phone number
- Prefers Discord guild display name, then username
- Stores auth/session data in `~/.local/share/whiscord`
- Keeps setup interactive inside the same binary you run in production

## Setup

```bash
bun install
bun run setup
```

The setup wizard asks for:

- Discord bot token
- Discord channel ID
- A WhatsApp QR scan in the terminal
- WhatsApp target group, chosen from your actual joined groups after login

It writes the config to `~/.local/share/whiscord/config.json` and keeps WhatsApp auth in `~/.local/share/whiscord/whatsapp-auth/`.

## Run

```bash
bun run server
```

## Notes

- The setup wizard always uses a terminal QR for WhatsApp pairing.
- The setup flow asks which WhatsApp group to bridge, then stores that group JID in config.
- The Discord bot needs `Guilds`, `Guild Messages`, and `Message Content` intents.
- Local runtime state lives in `~/.local/share/whiscord`.

## Build A Single Executable

Current platform:

```bash
bun run build:exe
```

Cross-compile example:

```bash
bun run build:exe -- --target bun-linux-x64 --outfile dist/whiscord-linux
```

This uses Bun's `--compile` support under the hood, disables runtime `.env` autoloading on purpose, and keeps `setup` interactive inside the built binary.

## Scripts

```bash
bun run setup
bun run server
bun run build:exe
bun run fmt
bun run lint
bun run typecheck
```
