import fs from "node:fs/promises";
import path from "node:path";
import { timeString, todayString } from "../memory.js";
import { personaPath, sharedPath } from "../config.js";
import type { ChatMessage } from "../llm.js";
import { stripFrontmatter } from "../utils.js";

const MAX_HISTORY = 50;

export function tempHistoryPath(
  channel: { id: string; isDMBased: () => boolean },
  persona = "wanshi",
): string {
  const name = channel.isDMBased() ? "dm" : `server-${channel.id}`;
  return personaPath(persona, "history", `${name}.md`);
}

async function initHistoryFile(filePath: string): Promise<void> {
  try { await fs.access(filePath); } catch {
    try { await fs.mkdir(path.dirname(filePath), { recursive: true }); await fs.writeFile(filePath, "---\ntags:\n  - elias\n  - elias/tempHistory\n---\n\n", "utf8"); } catch (err) { console.error("initHistoryFile failed:", err); }
  }
}

export async function loadHistory(filePath: string): Promise<ChatMessage[]> {
  await initHistoryFile(filePath);
  let raw: string;
  try { raw = await fs.readFile(filePath, "utf8"); } catch (err) { console.error("loadHistory readFile failed:", err); return []; }
  const body = stripFrontmatter(raw).trim();
  const messages: ChatMessage[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^\[.*?\]\s+(.+)/);
    if (!m) {
      // Continuation of the previous message (multi-line content)
      if (messages.length > 0) {
        const last = messages[messages.length - 1]!;
        last.content = typeof last.content === "string"
          ? last.content + "\n" + trimmed
          : last.content;
      }
      continue;
    }
    let content = m[1]!;
    // Assistant messages have "Name: content" without "(Role)" prefix
    // User messages have "Name (Role): content"
    if (content.includes("(") && content.includes(")")) {
      // User message — strip sender prefix
      const colonIdx = content.indexOf(": ");
      if (colonIdx > 0) content = content.slice(colonIdx + 2);
      messages.push({ role: "user", content });
    } else {
      // Assistant message — strip persona name prefix
      const colonIdx = content.indexOf(": ");
      if (colonIdx > 0) content = content.slice(colonIdx + 2);
      messages.push({ role: "assistant", content });
    }
  }
  return messages.slice(-MAX_HISTORY);
}

// ---------------------------------------------------------------------------
// In-memory session cache — the authoritative source for LLM context.
// File I/O is a side effect (log persistence). Cache bypasses the
// file parser entirely during normal operation; loadHistory is only
// the cold-start fallback.
// ---------------------------------------------------------------------------

const sessionCache = new Map<string, { messages: ChatMessage[]; mtime: number }>();

/** Return the cached message list for this channel, loading from file on first access. */
export async function getHistory(filePath: string): Promise<ChatMessage[]> {
  const cached = sessionCache.get(filePath);
  if (cached) {
    let stat;
    try { stat = await fs.stat(filePath); } catch { return cached.messages; }
    if (stat.mtimeMs > cached.mtime) {
      // File changed since last read — reload
      const fromFile = await loadHistory(filePath);
      sessionCache.set(filePath, { messages: fromFile, mtime: stat.mtimeMs });
      return fromFile;
    }
    return cached.messages;
  }

  const fromFile = await loadHistory(filePath);
  let mtime = 0;
  try {
    const stat = await fs.stat(filePath);
    mtime = stat.mtimeMs;
  } catch {
    // File may not exist yet — use current time
    mtime = Date.now();
  }
  sessionCache.set(filePath, { messages: fromFile, mtime });
  return fromFile;
}

/** Push a ChatMessage into the in-memory cache for this channel. */
export function pushHistoryMessage(filePath: string, message: ChatMessage): void {
  let cached = sessionCache.get(filePath);
  if (!cached) {
    cached = { messages: [], mtime: Date.now() };
    sessionCache.set(filePath, cached);
  }
  cached.messages.push(message);
  cached.mtime = Date.now();
  if (cached.messages.length > MAX_HISTORY) {
    cached.messages.splice(0, cached.messages.length - MAX_HISTORY);
  }
}

/**
 * Estimate token count with language-aware heuristics.
 * CJK characters are ~1.5 tokens each; ASCII is ~0.25 tokens each (4 chars ≈ 1 token).
 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk * 1.5 + other * 0.25);
}

// Per-file write lock to prevent race conditions
const writeLocks = new Map<string, Promise<void>>();

export async function appendHistory(filePath: string, entry: string): Promise<void> {
  // Serialize writes per file
  const prev = writeLocks.get(filePath) ?? Promise.resolve();
  const next = prev.then(async () => {
    await initHistoryFile(filePath);
    const line = `[${todayString()} ${timeString()}] ${entry}\n`;
    await fs.appendFile(filePath, line, "utf8");
  });
  writeLocks.set(filePath, next.then(() => {}).catch(() => {}));
  await next;
}

export async function clearHistory(filePath: string): Promise<void> {
  sessionCache.delete(filePath);
  await initHistoryFile(filePath);
  let raw: string;
  try { raw = await fs.readFile(filePath, "utf8"); } catch (err) { console.error("clearHistory readFile failed:", err); return; }
  const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n?/);
  const frontmatter = fmMatch ? fmMatch[0] : "";
  try { await fs.writeFile(filePath, frontmatter.trim() + "\n", "utf8"); } catch (err) { console.error("clearHistory writeFile failed:", err); }
}
