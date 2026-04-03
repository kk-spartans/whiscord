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
pnpm install
pnpm run setup
```

The setup wizard asks for:

- Discord bot token
- Discord channel ID
- A WhatsApp QR scan in the terminal
- WhatsApp target group, chosen from your actual joined groups after login

It writes the config to `~/.local/share/whiscord/config.json` and keeps WhatsApp auth in `~/.local/share/whiscord/whatsapp-auth/`.

## Run

```bash
pnpm run server
```

## Notes

- The setup wizard always uses a terminal QR for WhatsApp pairing.
- The setup flow asks which WhatsApp group to bridge, then stores that group JID in config.
- The Discord bot needs `Guilds`, `Guild Messages`, and `Message Content` intents.
- Local runtime state lives in `~/.local/share/whiscord`.

## Build A Single Executable

Current platform:

```bash
pnpm run build:exe
```

Native build example with a custom output path:

```bash
pnpm run build:exe -- --outfile dist/whiscord-custom
```

This uses Node.js SEA (`node --build-sea`) under the hood, bundles the app first with `esbuild`, and keeps `setup` interactive inside the built binary.

## Scripts

```bash
pnpm run setup
pnpm run server
pnpm run build:exe
pnpm run fmt
pnpm run lint
pnpm run typecheck
```
