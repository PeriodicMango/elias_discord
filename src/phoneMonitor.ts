import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { PATHS, sharedPath } from "../../../eliasCore/src/config.js";
import { triggerCheck } from "./proactive.js";
import { fileExists } from "../../../eliasCore/src/utils.js";

const PORT = 3456;
const VAULT_DIR = sharedPath("activity");
const MAX_ENTRIES = 700;

function todayFile(): string {
  const date = new Date().toLocaleString("sv-SE", { timeZone: "Australia/Sydney" }).slice(0, 10);
  return path.join(VAULT_DIR, `phone-${date}.md`);
}

async function appendActivity(line: string): Promise<void> {
  const file = todayFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (!(await fileExists(file))) {
    await fs.writeFile(file, "---\ntags:\n  - elias\n  - elias/activity\n---\n\n", "utf8");
  }
  await fs.appendFile(file, line + "\n", "utf8");

  // Trim
  const content = await fs.readFile(file, "utf8");
  const lines = content.split("\n");
  const entries = lines.filter((l) => l.startsWith("- ["));
  if (entries.length > MAX_ENTRIES) {
    const head = lines.slice(0, 5); // frontmatter
    const tail = entries.slice(-MAX_ENTRIES);
    await fs.writeFile(file, head.join("\n") + "\n\n" + tail.join("\n") + "\n", "utf8");
  }
}

export function startPhoneMonitor(): void {
  const server = http.createServer(async (req, res) => {
    console.log(`[PHONE] ${req.method} ${req.url} from ${req.socket.remoteAddress}`);

    // Location endpoint
    if (req.method === "POST" && req.url === "/location") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const clean = body.replace(/["“”＂]/g, '"');
          const { lat, lng } = JSON.parse(clean) as { lat?: number; lng?: number };
          if (lat == null || lng == null) { res.writeHead(400).end("missing lat/lng"); return; }
          const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
          const locFile = path.join(VAULT_DIR, `location-${new Date().toLocaleString("sv-SE", { timeZone: "Australia/Sydney" }).slice(0, 10)}.md`);
          if (!(await fileExists(locFile))) {
            await fs.mkdir(path.dirname(locFile), { recursive: true });
            await fs.writeFile(locFile, "---\ntags:\n  - elias\n  - elias/activity\n---\n\n", "utf8");
          }
          await fs.appendFile(locFile, `- [${ts}] ${lat},${lng}\n`, "utf8");
          triggerCheck();
          res.writeHead(200).end("ok");
        } catch { res.writeHead(400).end("bad json"); }
      });
      return;
    }

    // Health check for browser
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }

    if (req.method === "POST" && req.url === "/activity") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        // Normalize smart quotes from Android input
        const clean = body.replace(/[“”‘’＂]/g, '"');
        console.log(`[PHONE] body: ${clean}`);
        try {
          const { app } = JSON.parse(clean) as { app?: string };
          if (!app) {
            res.writeHead(400, { "Content-Type": "text/plain" }).end("missing app");
            return;
          }
          const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
          await appendActivity(`- [${ts}] [phone] ${app}`);
          triggerCheck(); // immediate proactive check
          res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
        } catch (e) {
          res.writeHead(400, { "Content-Type": "text/plain" }).end(`bad json: ${e}`);
        }
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[SYSTEM LOG] Phone monitor: port ${PORT} already in use.`);
    } else {
      console.error(`[SYSTEM LOG] Phone monitor error: ${err.message}`);
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[SYSTEM LOG] Phone monitor listening on port ${PORT}.`);
  });
}
