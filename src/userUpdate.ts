import fs from "node:fs/promises";
import path from "node:path";
import { PATHS } from "../../../eliasCore/src/config.js";
import { chat } from "../../../eliasCore/src/llm.js";
import { loadTaskFragment } from "../../../eliasCore/src/prompt.js";

const DATA_FILE = path.join(PATHS.base, "data.json");
const DAILY_NOTES_DIR = path.join(PATHS.knowledgeBase, "Daily Notes");

async function getLastMark(): Promise<string> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    return (JSON.parse(raw) as { lastUserUpdate: string }).lastUserUpdate ?? "2026-01-01T00:00:00Z";
  } catch {
    return "2026-01-01T00:00:00Z";
  }
}

async function setLastMark(iso: string): Promise<void> {
  const raw = await fs.readFile(DATA_FILE, "utf8");
  const data = JSON.parse(raw) as Record<string, unknown>;
  data.lastUserUpdate = iso;
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

async function collectNewNotes(since: Date): Promise<string[]> {
  const sinceMs = since.getTime();
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name as string);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!(e.name as string).endsWith(".md")) continue;
      const stat = await fs.stat(full);
      if (stat.mtimeMs > sinceMs) files.push(full);
    }
  }

  await walk(DAILY_NOTES_DIR);
  return files;
}

async function applyUpdates(updates: string): Promise<void> {
  const masterFile = path.join(PATHS.knowledgeBase, "Elias", "Master", "漓琊.md");
  const userFile = PATHS.user;

  const now = new Date().toLocaleString("sv-SE", { timeZone: "Australia/Sydney" }).slice(0, 10);

  // Append to master knowledge file
  const lines = updates
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("[新增]") || l.startsWith("[更新]"));

  if (lines.length === 0) return;

  for (const line of lines) {
    const fact = line.replace(/^\[(新增|更新)\]\s*/, "");
    await fs.appendFile(masterFile, `- [${now}] ${fact}\n`, "utf8");
  }

  // Also append a summary to user.md
  const summary = lines
    .map((l) => `- ${l.replace(/^\[(新增|更新)\]\s*/, "").trim()}`)
    .join("\n");

  let userContent = await fs.readFile(userFile, "utf8");
  userContent += `\n## 最近更新 (${now})\n${summary}\n`;
  await fs.writeFile(userFile, userContent, "utf8");
}

export async function runUserUpdate(): Promise<string> {
  const lastMark = await getLastMark();
  const since = new Date(lastMark);
  const files = await collectNewNotes(since);

  if (files.length === 0) return "没有发现自上次更新以来的新日记。";

  const notes: Record<string, string> = {};
  for (const f of files) {
    const rel = path.relative(DAILY_NOTES_DIR, f);
    notes[rel] = await fs.readFile(f, "utf8");
  }

  // Load the task fragment (SYSTEM DIRECTIVE portion)
  const directiveFragment = await loadTaskFragment("tasks/user-update", {
    NOTE_COUNT: String(files.length),
  });

  // Build the diary content portion (stays as user message — too large for template vars)
  const bodies = Object.entries(notes)
    .map(([name, content]) => `### ${name} ###\n${content.slice(0, 2000)}`)
    .join("\n\n---\n\n");

  const result = await chat([
    { role: "system", content: directiveFragment },
    { role: "user", content: `日记内容：\n\n${bodies}` },
  ]);
  const raw = result.text;

  if (raw.includes("NO_NEW_INFO")) {
    // Still update the mark so we don't re-process same files
    const now = new Date().toISOString();
    await setLastMark(now);
    return `已扫描 ${files.length} 篇新日记，未发现需要更新的用户信息。`;
  }

  const match = /<USER_UPDATE>([\s\S]*?)<\/USER_UPDATE>/.exec(raw);
  const updates = match ? (match[1] ?? "").trim() : "";

  if (!updates || updates === "NO_NEW_INFO") {
    const now = new Date().toISOString();
    await setLastMark(now);
    return `已扫描 ${files.length} 篇新日记，未发现需要更新的用户信息。`;
  }

  await applyUpdates(updates);
  const now = new Date().toISOString();
  await setLastMark(now);

  const count = updates.split("\n").filter((l) => l.trim()).length;
  return `已扫描 ${files.length} 篇新日记，提取了 ${count} 条用户信息更新。`;
}
