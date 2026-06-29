import fs from "node:fs/promises";
import path from "node:path";
import { PATHS, personaPath, sharedPath } from "../../../eliasCore/src/config.js";
import { sydneyDate } from "../../../eliasCore/src/utils.js";
import { chat } from "../../../eliasCore/src/llm.js";
import { loadTaskFragment } from "../../../eliasCore/src/prompt.js";

interface PersonaData {
  lastUserUpdate?: string;
  activePersona?: string;
  personaTimestamps?: Record<string, string>;
}

async function readData(): Promise<PersonaData> {
  const raw = await fs.readFile(path.join(PATHS.base, "data.json"), "utf8");
  return JSON.parse(raw) as PersonaData;
}

async function getNewContentSince(
  dir: string,
  since: Date,
  filterThinking = false,
): Promise<string> {
  const sinceSydney = sydneyDate(since);
  let result = "";
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md")).sort();
    for (const f of files) {
      const filePath = path.join(dir, f);
      const content = await fs.readFile(filePath, "utf8");
      let lines = content.split("\n");
      if (filterThinking) lines = lines.filter((l) => !l.includes("thinking:"));

      const newLines: string[] = [];
      for (const line of lines) {
        const tsMatch = line.match(/^\[(\d{2}:\d{2}:\d{2})\]/);
        if (tsMatch) {
          // Filename uses UTC date; lines use Sydney time. Try both the since-
          // day and the next day in Sydney, pick whichever is closest to since.
          const dateFromFilename = f.replace(/\.md$/, "").slice(0, 10);
          const candidates = [dateFromFilename, sinceSydney];
          let bestLineTime: Date | null = null;
          for (const d of candidates) {
            if (!d.match(/^\d{4}-\d{2}-\d{2}$/)) continue;
            const t = new Date(`${d}T${tsMatch[1]}+10:00`);
            if (!bestLineTime || Math.abs(t.getTime() - since.getTime()) < Math.abs(bestLineTime.getTime() - since.getTime())) {
              bestLineTime = t;
            }
          }
          if (bestLineTime && bestLineTime <= since) continue;
        }
        newLines.push(line);
      }

      if (newLines.length > 0) {
        result += `\n### ${f} ###\n${newLines.join("\n").slice(0, 3000)}`;
      }
    }
  } catch { /* dir may not exist */ }
  return result;
}

/**
 * Run on persona switch. The incoming persona reads new logs/summaries
 * since they were last active and writes observations to their notebook.
 */
export async function processPersonaTransition(incoming: string): Promise<string> {
  const data = await readData();
  const timestamps = data.personaTimestamps ?? {};
  const incomingLastActive = timestamps[incoming];

  // Note: outgoing's timestamp is set by the caller (switchPersona)

  // Find new content since incoming persona was last active
  const since = incomingLastActive ? new Date(incomingLastActive) : new Date(0);
  if (Date.now() - since.getTime() < 60_000) {
    // Less than a minute — nothing to process
    return "";
  }

  const newLogs = await getNewContentSince(personaPath(incoming, "daily_log"), since, true);
  const newSummaries = await getNewContentSince(personaPath(incoming, "daily_summary"), since);

  if (!newLogs && !newSummaries) return "";

  const personaFile = path.join(PATHS.base, "personas", `${incoming}.md`);
  let soul = `You are ${incoming}.`;
  try { soul = await fs.readFile(personaFile, "utf8"); } catch { /* use default */ }

  const hoursAgo = Math.round((Date.now() - since.getTime()) / 3600000);
  const timeSpan = hoursAgo < 1 ? "不到一小时" : hoursAgo < 24 ? `${hoursAgo} 小时` : `${Math.round(hoursAgo / 24)} 天`;

  // Load the transition directive fragment
  const transitionFragment = await loadTaskFragment("tasks/persona-transition", {
    PERSONA: incoming,
    TIME_SPAN: timeSpan,
  });

  // Combine soul + fragment as system prompt, content as user message
  const result = await chat([
    { role: "system", content: `${soul}\n\n${transitionFragment}` },
    { role: "user", content: `${newLogs}\n${newSummaries}` },
  ]);
  const note = result.text.trim();

  if (note && note !== "NO_NOTE") {
    const nbDir = sharedPath("persona-memory", incoming);
    const nbFile = path.join(nbDir, "notebook.md");
    await fs.mkdir(nbDir, { recursive: true });
    try { await fs.access(nbFile); } catch {
      await fs.writeFile(nbFile, `---\ntags:\n  - elias\n  - elias/persona-memory\npersona: ${incoming}\n---\n\n`, "utf8");
    }
    const localTS = new Date().toLocaleString("sv-SE", { timeZone: "Australia/Sydney" }).replace(" ", "T");
    await fs.appendFile(nbFile, `- [${localTS}] ${note}\n`, "utf8");
    return note;
  }

  return "";
}
