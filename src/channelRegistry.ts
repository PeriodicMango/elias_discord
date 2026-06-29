import fs from "node:fs/promises";
import path from "node:path";
import { PATHS } from "../../../eliasCore/src/config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersonaChannelConfig {
  channelId: string | null;
  displayName: string;
  avatarUrl: string;
  enabled: boolean;
}

export interface GroupChatConfig {
  channelId: string | null;
  personas: string[];
  enabled: boolean;
}

export interface ChannelConfig {
  personas: Record<string, PersonaChannelConfig>;
  groupChat: GroupChatConfig;
  dmDefaultPersona: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let cachedConfig: ChannelConfig | null = null;

export function clearChannelCache(): void {
  cachedConfig = null;
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

export async function loadChannels(): Promise<ChannelConfig> {
  if (cachedConfig) return cachedConfig;
  try {
    const raw = await fs.readFile(PATHS.channelsConfig, "utf8");
    cachedConfig = JSON.parse(raw) as ChannelConfig;
    return cachedConfig!;
  } catch {
    // Return a minimal default that won't break existing behavior
    const fallback: ChannelConfig = {
      personas: {},
      groupChat: { channelId: null, personas: [], enabled: false },
      dmDefaultPersona: "elias",
    };
    return fallback;
  }
}

export async function saveChannels(cfg: ChannelConfig): Promise<void> {
  await fs.mkdir(path.dirname(PATHS.channelsConfig), { recursive: true });
  await fs.writeFile(PATHS.channelsConfig, JSON.stringify(cfg, null, 2), "utf8");
  cachedConfig = cfg;
}

// ---------------------------------------------------------------------------
// Persona queries
// ---------------------------------------------------------------------------

export async function getPersonaForChannel(channelId: string): Promise<string | null> {
  const cfg = await loadChannels();
  for (const [name, config] of Object.entries(cfg.personas)) {
    if (config.channelId === channelId && config.enabled) return name;
  }
  return null;
}

export async function getChannelForPersona(persona: string): Promise<string | null> {
  const cfg = await loadChannels();
  return cfg.personas[persona]?.channelId ?? null;
}

export async function getEnabledPersonas(): Promise<string[]> {
  const cfg = await loadChannels();
  return Object.entries(cfg.personas)
    .filter(([, c]) => c.enabled && c.channelId)
    .map(([name]) => name);
}

export async function getPersonaConfig(persona: string): Promise<PersonaChannelConfig | null> {
  const cfg = await loadChannels();
  return cfg.personas[persona] ?? null;
}

// ---------------------------------------------------------------------------
// Group chat queries
// ---------------------------------------------------------------------------

export async function getGroupChatPersonas(): Promise<string[]> {
  const cfg = await loadChannels();
  if (!cfg.groupChat.enabled) return [];
  return cfg.groupChat.personas;
}

export async function isGroupChatChannel(channelId: string): Promise<boolean> {
  const cfg = await loadChannels();
  if (!cfg.groupChat.enabled) return false;
  return channelId === cfg.groupChat.channelId;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export async function getDmPersona(): Promise<string> {
  const cfg = await loadChannels();
  return cfg.dmDefaultPersona || "elias";
}
