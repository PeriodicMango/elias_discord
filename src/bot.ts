// ---------------------------------------------------------------------------
// Elias Discord Bot v3 — minimal rebuild: message pipe + four mods.
//
// Run:  npx tsx src/bot.ts
// Dependencies: discord.js, @periodicmango/elias, persona-mod, jiwen-mod,
//               auth-mod, dotenv
// ---------------------------------------------------------------------------

import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from "discord.js";
import {
  initBrain,
  getBrain,
  createTimeMod,
  EliasError,
  ModPreflightError,
  LlmHttpError,
  LlmTimeoutError,
} from "@periodicmango/elias";
import { PersonaManager } from "persona-mod";
import { JiwenManager } from "jiwen-mod";
import { AuthManager } from "auth-mod";
import { getHistory, appendHistory } from "./history.js";

// ── Config from environment ────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN!;
const CHANNEL_ID = process.env.CHANNEL_ID!;
const DEFAULT_PERSONA = process.env.DEFAULT_PERSONA || "wanshi";
const MASTER_KEY = process.env.MASTER_SETUP_KEY!;

const TZ = process.env.TZ || "Australia/Sydney";
const LOCALE = process.env.LOCALE || "zh-CN";

const PERSONA_DIR = process.env.PERSONA_DIR || "./personas";
const JIWEN_DATA_DIR = process.env.JIWEN_DATA_DIR || "./jiwen-data";
const AUTH_DATA_DIR = process.env.AUTH_DATA_DIR || "./auth-data";

const LLM_API_KEY = process.env.LLM_API_KEY!;
const LLM_API_URL = process.env.LLM_API_URL!;
const LLM_MODEL = process.env.LLM_MODEL!;

// ── Per-user persona sticky state (D3/D9) ─────────────────────────────────
const personaMap = new Map<string, string>();

// ── Startup ────────────────────────────────────────────────────────────────

console.log("[elias] loading mods…");

const personaManager = await PersonaManager.load(PERSONA_DIR);
const jiwenManager = await JiwenManager.load({ dataDir: JIWEN_DATA_DIR });
const authManager = await AuthManager.load({
  dataDir: AUTH_DATA_DIR,
  getMasterTitle: (persona) => {
    // persona-mod's frontmatter meta carries master_title (A10/P6′)
    try {
      const m = personaManager.get(persona).meta;
      return (typeof m.master_title === "string" && m.master_title) || "主人";
    } catch {
      return "主人";
    }
  },
});
const timeMod = createTimeMod({
  timeZone: TZ,
  locale: LOCALE,
  label: "当前时间",
});

// ── Master bootstrap (A2) ─────────────────────────────────────────────────
if (!authManager.masterClaimed) {
  console.log("[elias] claiming master with MASTER_SETUP_KEY…");
  await authManager.claimSetupKey(MASTER_KEY, "漓琊");
}

// ── Ensure the owner's Discord binding exists ─────────────────────────────
// In production the master adds their Discord binding once via a setup step.
// For now, a missing master binding is logged but not fatal — the first
// message from the owner will route through the anonymous cold voice until
// binding is added.
if (!authManager.whois(`discord:${process.env.OWNER_DISCORD_ID ?? "0"}`)) {
  console.log("[elias] master has no Discord binding yet — first message will be anonymous.");
  console.log("[elias] add a binding with: await authManager.addBinding('master', 'discord:YOUR_ID')");
}

// ── Brain ─────────────────────────────────────────────────────────────────
console.log("[elias] booting brain…");

await initBrain({
  baseDir: ".",
  apiKey: LLM_API_KEY,
  apiUrl: LLM_API_URL,
  model: LLM_MODEL,
  mcpServers: [],
  mods: [personaManager, authManager, jiwenManager, timeMod], // D4: 顺序注入
});

console.log("[elias] brain ready.");

// ── Discord client ─────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Slash command: /persona (D3) ──────────────────────────────────────────
const personaCmd = new SlashCommandBuilder()
  .setName("persona")
  .setDescription("切换当前 persona")
  .addStringOption((opt) =>
    opt
      .setName("name")
      .setDescription("persona 名称")
      .setRequired(true)
      .setAutocomplete(true),
  );

client.once("ready", async () => {
  await client.application!.commands.set([personaCmd]);
  console.log(`[elias] online as ${client.user!.tag} in channel ${CHANNEL_ID}`);
});

// ── Autocomplete: persona list ─────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "name") return;
    const choices = personaManager
      .list()
      .filter((p) => p.id.includes(focused.value))
      .slice(0, 20)
      .map((p) => ({ name: `${p.displayName} (${p.id})`, value: p.id }));
    await interaction.respond(choices);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction as ChatInputCommandInteraction;
  if (cmd.commandName !== "persona") return;

  const name = cmd.options.getString("name", true);
  // validate persona exists
  try {
    personaManager.get(name);
  } catch {
    await cmd.reply({ content: `persona "${name}" 不存在。`, ephemeral: true });
    return;
  }

  const userId = `discord:${cmd.user.id}`;
  const old = personaMap.get(userId);
  personaMap.set(userId, name);
  await cmd.reply({
    content: old
      ? `已从 ${old} 切换到 ${name}。`
      : `当前 persona: ${name}。`,
    ephemeral: true,
  });
});

// ── Message handler (D1/D2/D5/D7) ─────────────────────────────────────────
client.on("messageCreate", async (msg) => {
  // DM → ignore
  if (!msg.guildId) return;

  // Only the configured channel
  if (msg.channelId !== CHANNEL_ID) return;

  // Ignore bots (including self)
  if (msg.author.bot) return;

  const userId = `discord:${msg.author.id}`;
  const persona = personaMap.get(userId) ?? DEFAULT_PERSONA;

  let replyText: string;

  // Start typing indicator
  await msg.channel.sendTyping();

  try {
    const history = getHistory(userId);
    appendHistory(userId, { role: "user", content: msg.content });

    const reply = await getBrain().chat({
      content: msg.content,
      meta: { persona, userId },
      allowedTools: authManager.toolsFor(userId), // D5: undefined for master = all
      history,
    });

    replyText = reply.text || "（…）";

    // Send reply — Discord 2000 char cap; split on paragraphs if needed
    if (replyText.length <= 2000) {
      await msg.channel.send(replyText);
    } else {
      const chunks = splitLongMessage(replyText);
      for (const chunk of chunks) {
        await msg.channel.send(chunk);
      }
    }

    appendHistory(userId, { role: "assistant", content: replyText });

    // Jiwen mechanical feedback (connection was just fulfilled)
    await jiwenManager.userReplied(persona);
  } catch (err) {
    if (err instanceof ModPreflightError) {
      replyText = `[${err.code}] mod(s) failed: ${err.failures.map((f) => f.mod).join(", ")}`;
    } else if (err instanceof LlmHttpError) {
      replyText = `[${err.code}] LLM returned HTTP ${err.status}`;
    } else if (err instanceof LlmTimeoutError) {
      replyText = `[${err.code}] LLM request timed out`;
    } else if (err instanceof EliasError) {
      replyText = `[EliasError] ${(err as EliasError).message}`;
    } else {
      console.error("[elias] unexpected error:", err);
      replyText = "我暂时无法回应。";
    }
    await msg.channel.send(replyText);
  }
});

// ── Go ─────────────────────────────────────────────────────────────────────
await client.login(TOKEN);

// ── Helpers ────────────────────────────────────────────────────────────────

/** Split a long message on paragraph boundaries, keeping each ≤ 2000 chars. */
function splitLongMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= 2000) {
      chunks.push(remaining);
      break;
    }
    // Try to break at the last paragraph gap before 2000
    const slice = remaining.slice(0, 2000);
    const lastBreak = slice.lastIndexOf("\n\n");
    const cut = lastBreak > 100 ? lastBreak : slice.lastIndexOf("\n");
    const splitAt = cut > 100 ? cut : 1990;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}
