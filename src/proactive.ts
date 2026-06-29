import fs from "node:fs/promises";
import path from "node:path";
import { Client, TextBasedChannel } from "discord.js";
import { PATHS, sharedPath, personaPath } from "../../../eliasCore/src/config.js";
import { loadSoul, loadTaskFragment } from "../../../eliasCore/src/prompt.js";
import { chatDualPipeline } from "../../../eliasCore/src/llm.js";
import { appendDailyLogRaw, timeString } from "../../../eliasCore/src/memory.js";
import { appendHistory } from "../../../eliasCore/src/helpers/history.js";
import { getCurrentStatus } from "./status.js";
import { getEnabledPersonas, getChannelForPersona } from "./channelRegistry.js";
import { parseMoodTag } from "./moodParser.js";
import { buildStatusEmbed } from "./embedBuilder.js";

const DEBOUNCE_MS = 2 * 60 * 1000;
let storedClient: Client | null = null;

// Per-persona state
const lastChecks = new Map<string, number>();
const lastMessages = new Map<string, string>();

function randomInterval(): number {
  return (40 + Math.floor(Math.random() * 20)) * 60 * 1000; // 40-60 min
}

// ---------------------------------------------------------------------------
// Activity reading (shared across all personas — same PC/phone data)
// ---------------------------------------------------------------------------

async function readRecentActivity(): Promise<string> {
  const date = new Date().toLocaleString("sv-SE", { timeZone: "Australia/Sydney" }).slice(0, 10);
  const activityDir = sharedPath("activity");
  const results: string[] = [];

  try {
    const pcFile = path.join(activityDir, `${date}.md`);
    const pc = await fs.readFile(pcFile, "utf8");
    const lines = pc.split("\n").filter((l) => l.startsWith("- [")).slice(-15);
    if (lines.length > 0) results.push("### 电脑 ###\n" + lines.join("\n"));
  } catch { /* ok */ }

  try {
    const phFile = path.join(activityDir, `phone-${date}.md`);
    const ph = await fs.readFile(phFile, "utf8");
    const phLines = ph.split("\n").filter((l) => l.startsWith("- [")).slice(-10);
    if (phLines.length > 0) results.push("### 手机 ###\n" + phLines.join("\n"));
  } catch { /* ok */ }

  return results.join("\n\n") || "(暂无活动数据)";
}

async function readRecentContext(persona: string): Promise<string> {
  const historyDir = personaPath(persona, "history");
  try {
    // Collect recent messages across ALL history files for this persona
    // (DM, persona channel, group chat — whichever has the most recent activity)
    const allLines: Array<{ time: number; text: string }> = [];
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;

    const files = (await fs.readdir(historyDir)).filter((f) => f.endsWith(".md"));
    for (const f of files) {
      const raw = await fs.readFile(path.join(historyDir, f), "utf8");
      for (const line of raw.split("\n")) {
        const tsMatch = line.match(/^\[(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\]/);
        if (!tsMatch) continue;
        const lineTime = new Date(`${tsMatch[1]}T${tsMatch[2]}+10:00`).getTime();
        if (isNaN(lineTime) || lineTime < cutoff) continue;

        const content = line.replace(/^\[.*?\]\s+/, "").trim();
        if (!content) continue;

        const isUser = content.includes("(Master)") || content.includes("(Friend)");
        const clean = content.replace(/^[^:]+:\s*/, "");
        allLines.push({ time: lineTime, text: `[${isUser ? "漓琊" : persona}] ${clean}` });
      }
    }

    allLines.sort((a, b) => a.time - b.time);
    const recent = allLines.slice(-8).map((l) => l.text);
    if (recent.length === 0) return "(暂无近期对话)";
    return recent.join("\n");
  } catch {
    return "(暂无近期对话)";
  }
}

// ---------------------------------------------------------------------------
// Global pause
// ---------------------------------------------------------------------------

async function readDataJson(): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(path.join(PATHS.base, "data.json"), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch { return {}; }
}

async function isPaused(): Promise<boolean> {
  const data = await readDataJson();
  if (!data.proactivePausedUntil) return false;
  return Date.now() < new Date(data.proactivePausedUntil as string).getTime();
}

/** Per-persona proactive toggle — stored in data.json as proactiveDisabled: string[]. */
export async function isPersonaProactiveDisabled(persona: string): Promise<boolean> {
  const data = await readDataJson();
  const disabled = (data.proactiveDisabled as string[]) ?? [];
  return disabled.includes(persona);
}

export async function setPersonaProactiveDisabled(persona: string, disabled: boolean): Promise<void> {
  const dataFile = path.join(PATHS.base, "data.json");
  const data = await readDataJson();
  let list = (data.proactiveDisabled as string[]) ?? [];
  if (disabled) {
    if (!list.includes(persona)) list.push(persona);
  } else {
    list = list.filter((p) => p !== persona);
  }
  data.proactiveDisabled = list;
  await fs.writeFile(dataFile, JSON.stringify(data, null, 2), "utf8");
}

export async function getProactiveDisabledPersonas(): Promise<string[]> {
  const data = await readDataJson();
  return (data.proactiveDisabled as string[]) ?? [];
}

// ---------------------------------------------------------------------------
// Per-persona check
// ---------------------------------------------------------------------------

async function runPersonaCheck(persona: string, trigger: "timer" | "phone"): Promise<void> {
  const client = storedClient;
  if (!client) return;
  const now = Date.now();

  if (await isPaused()) return;
  if (await isPersonaProactiveDisabled(persona)) return;

  // Per-persona debounce (shared slot for all personas to avoid burst)
  // But each persona can run independently
  const lastCheck = lastChecks.get(persona) ?? 0;
  if (now - lastCheck < DEBOUNCE_MS) return;

  lastChecks.set(persona, now);

  // Get persona's channel
  const channelId = await getChannelForPersona(persona);
  if (!channelId) return; // persona has no channel configured

  let channel: TextBasedChannel;
  try {
    const fetched = await client.channels.fetch(channelId);
    if (!fetched || !("send" in fetched)) return;
    channel = fetched as unknown as TextBasedChannel;
  } catch {
    return; // channel not found
  }

  // Status gating
  const status = await getCurrentStatus(persona);
  if (!status.proactiveAllowed) return;

  try {
    const [activity, context, monitoringPrompt] = await Promise.all([
      readRecentActivity(),
      readRecentContext(persona),
      loadTaskFragment("tasks/proactive-check"),
    ]);

    const lastMsg = lastMessages.get(persona);
    const lastMsgNote = lastMsg ? `\n\n上次干预（严禁重复）：${lastMsg}` : "";
    const userMsg = `当前时间：${new Date().toLocaleString("zh-CN", { timeZone: "Australia/Sydney" })}\n\n近期对话：\n${context}\n\n当前活动：\n${activity}${lastMsgNote}`;

    const soul = await loadSoul(persona);
    const systemPrompt = `你是 ${persona}。保持此身份全程不变，不要给自己起新名字或新身份。\n\n${soul}\n\n${status.promptInject}\n\n${monitoringPrompt}`;

    const result = await chatDualPipeline(
      [{ role: "user", content: userMsg }],
      systemPrompt,
      systemPrompt,
    );

    if (result.thinking) {
      try { await appendDailyLogRaw(`[${timeString()}] Proactive thinking:\n${result.thinking}\n---\n`, persona); } catch {}
    }

    const trimmed = result.text.trim();
    if (trimmed && trimmed !== "NO_ACTION") {
      const moodParsed = parseMoodTag(trimmed);
      const cleanText = moodParsed.text.trim();
      if (!cleanText) return;

      const embed = buildStatusEmbed(persona, moodParsed.mood, result.toolsUsed);
      if (embed) {
        await (channel as { send: (opts: { content: string; embeds: unknown[] }) => Promise<unknown> }).send({
          content: cleanText,
          embeds: [embed],
        });
      } else {
        await (channel as { send: (msg: string) => Promise<unknown> }).send(cleanText);
      }
      lastMessages.set(persona, cleanText);

      // Log to persona's history
      const histFile = personaPath(persona, "history", `server-${channelId}.md`);
      await appendHistory(histFile, `${persona}: ${trimmed}`);

      console.log(`[PROACTIVE] ${persona}: ${trimmed.slice(0, 80)}`);
    }
  } catch (err) {
    console.error(`[PROACTIVE] Check error (${persona}): ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Phone trigger — fires all enabled persona checks
// ---------------------------------------------------------------------------

export function triggerCheck(): void {
  getEnabledPersonas().then((personas) => {
    for (const p of personas) {
      runPersonaCheck(p, "phone").catch(() => {});
    }
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Start per-persona proactive loops
// ---------------------------------------------------------------------------

export function startProactiveLoops(client: Client): void {
  storedClient = client;

  getEnabledPersonas().then((personas) => {
    if (personas.length === 0) {
      console.log("[SYSTEM LOG] No enabled personas found — proactive disabled.");
      return;
    }

    console.log(`[SYSTEM LOG] Proactive monitor started for ${personas.length} persona(s): ${personas.join(", ")}`);

    for (const persona of personas) {
      // Randomize initial delay so personas don't fire together
      const initialDelay = 2 * 60 * 1000 + Math.random() * 5 * 60 * 1000;

      function scheduleNext(): void {
        const delay = randomInterval();
        setTimeout(() => {
          runPersonaCheck(persona, "timer").catch(() => {});
          scheduleNext();
        }, delay);
      }

      setTimeout(() => {
        runPersonaCheck(persona, "timer").catch(() => {});
        scheduleNext();
      }, initialDelay);
    }
  }).catch(() => {});
}
