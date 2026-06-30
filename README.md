# elias-discord

Discord bot platform for Elias. Connects Discord to eliasCore.

## Features

- Multi-persona chat (wanshi, elias, raw, etc.)
- Per-channel persona binding
- Slash commands for persona management, goals, settings
- Proactive messaging (periodic check-ins)
- Status rotation
- Webhook-based persona message sending
- DM support with auto-master detection

## Structure

```
src/
  index.ts           ← Bot startup, app bootstrap, monitor init
  bot.ts             ← Message handling pipeline
  discord.ts         ← classifySender(), shouldRespond(), rewriteMentions()
  commands.ts         ← Slash commands (/list-personas, /goals, /set-master...)
  commandsDM.ts       ← DM commands
  channelRegistry.ts  ← Channel ↔ persona binding
  webhookManager.ts   ← Per-persona webhook sending
  proactive.ts        ← Proactive messaging loop
  status.ts           ← Discord presence rotation
  embedBuilder.ts     ← Discord embed construction
  moodParser.ts       ← Mood tag parsing from LLM output
  attachments.ts      ← File attachment processing
  phoneMonitor.ts     ← Phone data listener
  personaTransition.ts ← Persona switching logic
  userUpdate.ts       ← User profile updates
```

## Setup

```bash
npm install
```

Requires `eliasCore` in `../../eliasCore/`. The `.env` file lives in eliasCore:

```
DISCORD_TOKEN=...
DEEPSEEK_API_KEY=...
MASTER_ID=...
```

## Running

```bash
npm start
# or: npx tsx src/index.ts
```

## Slash Commands

| Command | Description |
|---------|-------------|
| `/list-personas` | List all personas |
| `/rename-persona` | Rename a persona |
| `/set-persona` | Set active persona |
| `/goals list` | List active goals |
| `/goals add` | Add a goal |
| `/goals done` | Mark goal complete |
| `/set-master` | Transfer master ownership |
| `/set-api` | Update API config |
| `/status` | Show bot status |
| `/history` | Show recent history |
