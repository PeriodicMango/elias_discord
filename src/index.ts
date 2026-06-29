import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { createBot } from "./bot.js";
import { DISCORD_TOKEN, PATHS, MCP_SERVERS, sharedPath } from "../../../eliasCore/src/config.js";
import { startPhoneMonitor } from "./phoneMonitor.js";
import { startProactiveLoops } from "./proactive.js";
import { catchUpMissedSummaries, startSummarizerLoop } from "../../../eliasCore/src/summarizer.js";
import { initializeMcp, getMcpStatus } from "../../../eliasCore/src/helpers/mcp.js";
import { rotateStatus, getCurrentStatus } from "./status.js";
import { ActivityType, Client } from "discord.js";
import { bootApps } from "../../../eliasCore/src/api/boot.js";

// Verify knowledge_base symlink resolves and is accessible
async function verifyKnowledgeBase(): Promise<void> {
  try {
    const stat = await fs.stat(PATHS.knowledgeBase);
    if (!stat.isDirectory()) {
      console.warn("[SYSTEM LOG] knowledge_base is not a directory — KB features unavailable.");
      return;
    }
    await fs.readdir(PATHS.knowledgeBase);
    console.log("[SYSTEM LOG] knowledge_base OK.");
  } catch (err) {
    console.error(`[SYSTEM LOG] knowledge_base unreachable: ${err}`);
    console.error("[SYSTEM LOG] Check that knowledge_base/ is accessible (see README for setup).");
  }
}

// Delete activity files older than 2 days
async function cleanupOldActivity(): Promise<void> {
  const dir = sharedPath("activity");
  const now = new Date();
  const cutoff = new Date(now.getTime() - 2 * 86400000);
  const cutoffStr = cutoff.toLocaleString("sv-SE", { timeZone: "Australia/Sydney" }).slice(0, 10);

  try {
    const files = await fs.readdir(dir);
    let deleted = 0;
    for (const f of files) {
      const match = f.match(/(\d{4}-\d{2}-\d{2})\.md$/);
      if (!match) continue;
      if (match[1]! < cutoffStr) {
        await fs.unlink(path.join(dir, f));
        deleted++;
      }
    }
    if (deleted > 0) console.log(`[SYSTEM LOG] Cleaned up ${deleted} old activity file(s).`);
  } catch { /* dir might not exist yet */ }
}

async function main(): Promise<void> {
  const client = createBot();

  // Launch activity monitor as background child process
  const monitorScript = path.join(PATHS.base, "scripts", "monitor-activity.sh");
  const monitor = spawn("bash", [monitorScript], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ELIAS_ACTIVITY_DIR: sharedPath("activity") },
  });
  monitor.unref();
  console.log("[SYSTEM LOG] Activity monitor started.");

  // Bootstrap apps (must happen before any tool execution)
  await bootApps();
  console.log("[SYSTEM LOG] Apps bootstrapped.");

  startPhoneMonitor();

  // Clean up old activity files every 6 hours
  setInterval(() => cleanupOldActivity().catch(() => {}), 6 * 60 * 60 * 1000);
  cleanupOldActivity().catch(() => {});

  // Health check before connecting to Discord
  await verifyKnowledgeBase();

  client.once("clientReady", () => {
    // Ensure webhooks exist for all configured channels
    import("./helpers/webhookManager.js")
      .then(({ ensureWebhooks }) => ensureWebhooks(client))
      .catch(() => {});

    startSummarizerLoop();
    catchUpMissedSummaries().catch((err) =>
      console.error(`[SYSTEM LOG] Summarizer catch-up failed: ${err}`),
    );
    console.log("[SYSTEM LOG] Background memory summarizer launched successfully.");
  });

  // Initialize MCP client (non-fatal — Elias works fine without MCP servers)
  await initializeMcp(MCP_SERVERS);
  const mcpStatus = getMcpStatus();
  if (mcpStatus.length > 0) {
    console.log(`[SYSTEM LOG] MCP: ${mcpStatus.map((s) => `${s.server}(${s.tools} tools${s.ok ? "" : " DOWN"})`).join(", ")}`);
  }

  await client.login(DISCORD_TOKEN);
  startProactiveLoops(client);
  startStatusRotation(client);
}

function startStatusRotation(client: Client): void {
  const ROTATION_MIN_MS = 30 * 60 * 1000;
  const ROTATION_MAX_MS = 60 * 60 * 1000;

  function randomDelay(): number {
    return ROTATION_MIN_MS + Math.floor(Math.random() * (ROTATION_MAX_MS - ROTATION_MIN_MS));
  }

  console.log("[SYSTEM LOG] Status rotation timer started (30-60 min interval).");

  function scheduleNext(): void {
    const delay = randomDelay();
    setTimeout(() => {
      rotateStatus()
        .then((newStatus) => {
          client.user?.setActivity(newStatus.label, { type: ActivityType.Custom });
          console.log(`[SYSTEM LOG] Status rotated to: ${newStatus.label}`);
        })
        .catch((err) => console.error(`[SYSTEM LOG] Status rotation error: ${err}`))
        .finally(() => scheduleNext());
    }, delay);
  }

  // First rotation after 5 min (give bot time to settle)
  setTimeout(() => {
    rotateStatus()
      .then((newStatus) => {
        client.user?.setActivity(newStatus.label, { type: ActivityType.Custom });
        console.log(`[SYSTEM LOG] Initial status: ${newStatus.label}`);
      })
      .catch(() => {})
      .finally(() => scheduleNext());
  }, 5 * 60 * 1000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
