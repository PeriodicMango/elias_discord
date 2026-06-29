import { Client, EmbedBuilder, TextBasedChannel, WebhookClient } from "discord.js";
import fs from "node:fs/promises";
import path from "node:path";
import { PATHS } from "../../../eliasCore/src/config.js";
import { getPersonaConfig } from "./channelRegistry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WebhookEntry {
  channelId: string;
  persona: string;
  webhookUrl: string;
}

interface WebhookConfig {
  entries: WebhookEntry[];
}

// ---------------------------------------------------------------------------
// Load / save webhooks.json
// ---------------------------------------------------------------------------

async function loadWebhooks(): Promise<WebhookEntry[]> {
  try {
    const raw = await fs.readFile(PATHS.webhooksConfig, "utf8");
    return (JSON.parse(raw) as WebhookConfig).entries;
  } catch {
    return [];
  }
}

async function saveWebhookUrl(channelId: string, persona: string, url: string): Promise<void> {
  const webhooks = await loadWebhooks();
  // Replace existing entry or add new
  const idx = webhooks.findIndex(
    (e) => e.channelId === channelId && e.persona === persona,
  );
  if (idx >= 0) {
    webhooks[idx]!.webhookUrl = url;
  } else {
    webhooks.push({ channelId, persona, webhookUrl: url });
  }
  await fs.mkdir(path.dirname(PATHS.webhooksConfig), { recursive: true });
  await fs.writeFile(
    PATHS.webhooksConfig,
    JSON.stringify({ entries: webhooks }, null, 2),
    "utf8",
  );
}

async function getWebhookUrl(
  channelId: string,
  persona: string,
): Promise<string | null> {
  const webhooks = await loadWebhooks();
  const entry = webhooks.find(
    (e) => e.channelId === channelId && e.persona === persona,
  );
  return entry?.webhookUrl ?? null;
}

// ---------------------------------------------------------------------------
// Send as persona (webhook or fallback)
// ---------------------------------------------------------------------------

/**
 * Send a message in a channel using the persona's webhook (name + avatar).
 * Falls back to channel.send() if no webhook is configured.
 */
export async function sendAsPersona(
  channel: TextBasedChannel,
  persona: string,
  text: string,
  client: Client,
  embed?: EmbedBuilder,
): Promise<void> {
  if (!text.trim()) return;

  const url = await getWebhookUrl(channel.id, persona);

  if (url) {
    const cfg = await getPersonaConfig(persona);
    try {
      const webhook = new WebhookClient({ url });
      const options: Record<string, unknown> = {
        content: text,
        username: cfg?.displayName || persona,
        avatarURL: cfg?.avatarUrl || undefined,
      };
      if (embed) options.embeds = [embed];
      await webhook.send(options as Parameters<typeof webhook.send>[0]);
      return;
    } catch (err) {
      console.warn(
        `[WEBHOOK] Failed to send as ${persona}: ${err}. Falling back to channel.send().`,
      );
    }
  }

  // Fallback: plain bot message (with embed support if provided)
  if (embed) {
    await (
      channel as { send: (opts: { content: string; embeds: EmbedBuilder[] }) => Promise<unknown> }
    ).send({ content: text, embeds: [embed] });
  } else {
    await (channel as { send: (msg: string) => Promise<unknown> }).send(text);
  }
}

// ---------------------------------------------------------------------------
// Webhook creation (called by /setup-webhooks command)
// ---------------------------------------------------------------------------

/**
 * Create Discord webhooks for the given personas in a channel.
 * Requires MANAGE_WEBHOOKS permission.
 */
export async function createWebhooksForChannel(
  client: Client,
  channelId: string,
  personas: string[],
): Promise<{ persona: string; ok: boolean; error?: string }[]> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !("createWebhook" in channel)) {
    return personas.map((p) => ({
      persona: p,
      ok: false,
      error: "Channel not found or not a guild text channel",
    }));
  }

  const results: { persona: string; ok: boolean; error?: string }[] = [];

  for (const persona of personas) {
    const cfg = await getPersonaConfig(persona);
    if (!cfg) {
      results.push({ persona, ok: false, error: "Persona not in channels.json" });
      continue;
    }

    try {
      const webhook = await (
        channel as { createWebhook: (opts: { name: string; avatar?: string }) => Promise<{ url: string }> }
      ).createWebhook({
        name: cfg.displayName || persona,
        avatar: cfg.avatarUrl || undefined,
      });
      await saveWebhookUrl(channelId, persona, webhook.url);
      results.push({ persona, ok: true });
      console.log(`[WEBHOOK] Created webhook for ${persona} in channel ${channelId}`);
    } catch (err) {
      results.push({ persona, ok: false, error: String(err) });
    }
  }

  return results;
}

/**
 * Ensure webhooks exist for all configured persona channels and group chat.
 * Called on startup. Skips silently if permissions are missing.
 */
export async function ensureWebhooks(client: Client): Promise<void> {
  // Lazy-import to avoid circular dependency
  const { loadChannels } = await import("./channelRegistry.js");
  const cfg = await loadChannels();

  // Persona channels
  for (const [persona, pcfg] of Object.entries(cfg.personas)) {
    if (!pcfg.channelId || !pcfg.enabled) continue;
    const existing = await getWebhookUrl(pcfg.channelId, persona);
    if (!existing) {
      try {
        const results = await createWebhooksForChannel(client, pcfg.channelId, [persona]);
        for (const r of results) {
          if (!r.ok) console.warn(`[WEBHOOK] Could not create webhook for ${persona}: ${r.error}`);
        }
      } catch { /* skip — may not have permission yet */ }
    }
  }

  // Group chat channel
  if (cfg.groupChat.enabled && cfg.groupChat.channelId) {
    for (const persona of cfg.groupChat.personas) {
      const existing = await getWebhookUrl(cfg.groupChat.channelId, persona);
      if (!existing) {
        try {
          const results = await createWebhooksForChannel(
            client,
            cfg.groupChat.channelId,
            [persona],
          );
          for (const r of results) {
            if (!r.ok) console.warn(`[WEBHOOK] Could not create group webhook for ${persona}: ${r.error}`);
          }
        } catch { /* skip */ }
      }
    }
  }

  console.log("[WEBHOOK] Webhook ensure complete.");
}
