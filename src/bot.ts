// ── Elias Discord Bot v3 — minimal rebuild: message pipe + 4 mods. ──────
//
// Mods are loaded dynamically via the workspace-level loader — adding a
// new mod means dropping a folder into ~/elias/mods/. Nobody reopens
// this file.
// ---------------------------------------------------------------------------
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
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
import { loadAllMods } from "../../mod-loader/loader/src/loadAllMods.js";
import { getHistory, appendHistory } from "./history.js";
import type { PersonaManager } from "persona-mod";
import type { JiwenManager } from "jiwen-mod";
import type { AuthManager } from "auth-mod";

// ── Config from environment ────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN!;
const CHANNEL_ID = process.env.CHANNEL_ID!;
const DEFAULT_PERSONA = process.env.DEFAULT_PERSONA || "wanshi";
const MASTER_KEY = process.env.MASTER_SETUP_KEY!;
const TZ = process.env.TZ || "Australia/Sydney";
const LOCALE = process.env.LOCALE || "zh-CN";
const LLM_API_KEY = process.env.LLM_API_KEY!;
const LLM_API_URL = process.env.LLM_API_URL!;
const LLM_MODEL = process.env.LLM_MODEL!;

// ── Per-user persona sticky state ─────────────────────────────────────────
const personaMap = new Map<string, string>();

// ── Startup: load all mods from workspace registry ─────────────────────────
console.log("[elias] loading mods…");

const loadedMods = await loadAllMods("../../mods");

const personaManager = loadedMods.find((m) => m.name === "persona") as PersonaManager | undefined;
const authManager = loadedMods.find((m) => m.name === "auth") as AuthManager | undefined;
const jiwenManager = loadedMods.find((m) => m.name === "jiwen") as JiwenManager | undefined;

if (!personaManager) throw new Error("[elias] persona-mod is required.");
if (!authManager) console.warn("[elias] auth-mod not loaded — running without authorization.");
if (!jiwenManager) console.warn("[elias] jiwen-mod not loaded — running without emotion engine.");

// ── Post-load wiring ──────────────────────────────────────────────────────
// auth needs persona info for master title injection
if (authManager) {
  // Patch getMasterTitle on the already-loaded auth instance (its preflight
  // reads getMasterTitle on every call, so we just need it on the object).
  const origPreflight = authManager.preflight.bind(authManager);
  authManager.preflight = async (ctx) => {
    const persona = ctx.meta.persona;
    try {
      const m = personaManager!.get(persona).meta;
      const title = (typeof m.master_title === "string" && m.master_title) || "主人";
      // inject master title into auth's injected text
      const result = await origPreflight(ctx);
      return { text: result.text };
    } catch {
      return origPreflight(ctx);
    }
  };
}

const timeMod = createTimeMod({ timeZone: TZ, locale: LOCALE, label: "当前时间" });

// Seed jiwen instances for loaded personas
if (jiwenManager) {
  for (const p of personaManager.list()) {
    try { await jiwenManager.addInstance(p.id); } catch { /* already exists */ }
  }
  console.log(`[elias] jiwen instances: ${jiwenManager.list().map((i) => i.id).join(", ")}`);
}

// Master bootstrap
if (authManager && !authManager.masterClaimed) {
  console.log("[elias] claiming master with MASTER_SETUP_KEY…");
  await authManager.claimSetupKey(MASTER_KEY, "漓琊");
}
const ownerDiscordId = `discord:${process.env.OWNER_DISCORD_ID ?? ""}`;
if (authManager && ownerDiscordId !== "discord:" && !authManager.whois(ownerDiscordId)) {
  await authManager.addBinding("master", ownerDiscordId);
  console.log(`[elias] master bound to ${ownerDiscordId}`);
}

// ── Brain ─────────────────────────────────────────────────────────────────
console.log("[elias] booting brain…");
await initBrain({
  baseDir: ".",
  apiKey: LLM_API_KEY,
  apiUrl: LLM_API_URL,
  model: LLM_MODEL,
  mcpServers: [],
  mods: loadedMods.concat(timeMod),
});
console.log("[elias] brain ready.");

// ── Discord client ─────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ── Slash command: /persona ───────────────────────────────────────────────
const personaCmd = new SlashCommandBuilder()
  .setName("persona")
  .setDescription("切换当前 persona")
  .addStringOption((opt) =>
    opt.setName("name").setDescription("persona 名称").setRequired(true).setAutocomplete(true),
  );

client.once("clientReady", async () => {
  await client.application!.commands.set([personaCmd]);
  console.log(`[elias] online as ${client.user!.tag} in channel ${CHANNEL_ID}`);
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "name") return;
    const choices = personaManager!
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
  try { personaManager!.get(name); } catch {
    await cmd.reply({ content: `persona "${name}" 不存在。`, ephemeral: true });
    return;
  }
  const userId = `discord:${cmd.user.id}`;
  const old = personaMap.get(userId);
  personaMap.set(userId, name);
  await cmd.reply({ content: old ? `已从 ${old} 切换到 ${name}。` : `当前 persona: ${name}。`, ephemeral: true });
});

// ── Message handler ────────────────────────────────────────────────────────
client.on("messageCreate", async (msg) => {
  if (!msg.guildId || msg.channelId !== CHANNEL_ID || msg.author.bot) return;

  const userId = `discord:${msg.author.id}`;
  const persona = personaMap.get(userId) ?? DEFAULT_PERSONA;
  let replyText: string;

  await msg.channel.sendTyping();

  try {
    const history = getHistory(userId);
    appendHistory(userId, { role: "user", content: msg.content });

    const reply = await getBrain().chat({
      content: msg.content,
      meta: { persona, userId },
      allowedTools: authManager?.toolsFor(userId),
      history,
    });

    replyText = reply.text || "（…）";

    if (replyText.length <= 2000) {
      await msg.channel.send(replyText);
    } else {
      for (const chunk of splitLongMessage(replyText)) await msg.channel.send(chunk);
    }

    appendHistory(userId, { role: "assistant", content: replyText });
    try { await jiwenManager?.userReplied(persona); } catch { /* no instance */ }
  } catch (err) {
    replyText = makeErrorReply(err);
    await msg.channel.send(replyText);
  }
});

// ── Go ─────────────────────────────────────────────────────────────────────
await client.login(TOKEN);

// ── Helpers ────────────────────────────────────────────────────────────────
function splitLongMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= 2000) { chunks.push(remaining); break; }
    const slice = remaining.slice(0, 2000);
    const lastBreak = slice.lastIndexOf("\n\n");
    const cut = lastBreak > 100 ? lastBreak : slice.lastIndexOf("\n");
    const splitAt = cut > 100 ? cut : 1990;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

function makeErrorReply(err: unknown): string {
  if (err instanceof ModPreflightError)
    return `[${err.code}] mod(s) failed: ${err.failures.map((f) => f.mod).join(", ")}`;
  if (err instanceof LlmHttpError) return `[${err.code}] LLM returned HTTP ${err.status}`;
  if (err instanceof LlmTimeoutError) return `[${err.code}] LLM request timed out`;
  if (err instanceof EliasError) return `[EliasError] ${(err as EliasError).message}`;
  console.error("[elias] unexpected error:", err);
  return "我暂时无法回应。";
}
