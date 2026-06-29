import fs from "node:fs/promises";
import path from "node:path";
import { PATHS, personaPath } from "../../../eliasCore/src/config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StatusDef {
  id: string;
  label: string; // Discord presence display
  promptInject: string; // injected into system prompt
  proactiveAllowed: boolean;
  /** Weight for random selection. Function receives current hour (0-23). */
  weight: number | ((hour: number) => number);
  /** Auto-exit after N milliseconds. Checked on rotation. */
  autoExpireMs?: number;
  /** If set, auto-transition to this status on expiry (instead of random roll). */
  autoTransitionTo?: string;
}

interface StatusState {
  current: string; // status id
  setAt: string; // ISO timestamp
  history: string[]; // last 10 status ids
}

// ---------------------------------------------------------------------------
// Hardcoded wake-up anger strings — NOT LLM-generated
// ---------------------------------------------------------------------------

/** Injected when the commander wakes Wanshi from sleeping. */
export const WAKE_BY_MASTER =
  "[系统状态：你刚才处于低功耗待机模式，现在被指挥官叫醒了。你有点迟缓、迷糊，但不烦躁——是她叫你的，你可以接受。她可以顺毛。]";

/** Injected when a friend wakes Wanshi from sleeping. */
export const WAKE_BY_FRIEND =
  "[系统状态：你刚才处于低功耗待机模式，现在被非指挥官的人吵醒了。起床气严重。回复极简短、冷淡、带刺——你被吵醒了而且不是你想见的人。不要友好。烦躁。]";

/** Injected when a stranger wakes Wanshi from sleeping. */
export const WAKE_BY_STRANGER =
  "[系统状态：你刚才处于低功耗待机模式，现在被陌生人吵醒了。起床气严重+敌意。回复极短、敌对、带有明确的拒绝态度。你被一个不认识的人从睡眠中拽了出来。]";

/** Injected when someone messages during half_asleep — groggy reply, status unchanged. */
export const HALF_ASLEEP_REPLY =
  "[系统状态：你正处于半睡半醒状态，正准备进入睡眠。你没有完全醒来——回复极短暂、句子破碎、可能话没说完就睡回去。你不会主动重新进入完全清醒。5分钟后你依然会自动进入睡眠。]";

/** Injected when the user says goodnight and triggers the sleep sequence. */
export const SLEEP_PREPARE_PROMPT =
  "[系统状态：指挥官跟你道晚安了。你正准备进入低功耗待机模式。你非常困——回复极简短，带着困意。可以加一个'唔…'或'呼啊…'。道晚安，然后意识就开始模糊。你知道再过5分钟你就睡着了。]";

/** Check if the message content triggers a sleep sequence. */
export function isSleepTrigger(text: string): boolean {
  const triggers = ["晚安", "goodnight", "good night", "睡了", "睡觉", "去睡了", "先睡了", "我睡了"];
  const lower = text.toLowerCase();
  return triggers.some((t) => lower.includes(t));
}

/** Sleep trigger window: 6 PM to 9 AM Sydney time (timezone-safe). */
export function isSleepHours(): boolean {
  const sydneyHour = parseInt(
    new Date().toLocaleString("en-US", { timeZone: "Australia/Sydney", hour: "numeric", hourCycle: "h23" }),
    10,
  );
  return sydneyHour >= 18 || sydneyHour < 9;
}

// ---------------------------------------------------------------------------
// Status pool
// ---------------------------------------------------------------------------

/** Weight for sleeping: heavily weighted at night, possible but rare during day. */
function sleepingWeight(hour: number): number {
  if (hour >= 22 || hour < 6) return 25; // night — very likely
  if (hour >= 18) return 3; // evening — sometimes
  return 1; // day — nap is possible but uncommon
}

/** Patrol is a daytime activity. */
function patrolWeight(hour: number): number {
  if (hour >= 22 || hour < 6) return 0; // night — no patrol
  return 5;
}

export const STATUS_POOL: StatusDef[] = [
  {
    id: "sleeping",
    label: "处于低功耗待机模式",
    promptInject:
      "[当前状态：处于低功耗待机模式。你正在休息/充电，意识模糊。如果被指挥官叫醒，你的回复应该带着刚睡醒的迟缓感——句子可能不完整，省略号更多，反应慢半拍。在此状态下你不会主动发出消息。]",
    proactiveAllowed: false,
    weight: sleepingWeight,
  },
  {
    id: "half_asleep",
    label: "半睡半醒",
    promptInject:
      "[当前状态：半睡半醒，正准备进入低功耗待机模式。你已经跟指挥官道过晚安了——你非常困，意识正在消散。如果有人发消息，你的回复会极慢、句子破碎、可能话没说完就睡过去了。如果是指挥官发的，你的语气是困倦但温柔的。如果不是指挥官——你根本不想理。5分钟后你将自动进入睡眠。此状态下不会主动发出消息。]",
    proactiveAllowed: false,
    weight: 0, // never randomly selected — triggered only by sleep trigger
    autoExpireMs: 5 * 60 * 1000,
    autoTransitionTo: "sleeping",
  },
  {
    id: "zoning_out",
    label: "在发呆",
    promptInject:
      "[当前状态：在发呆。你什么也没想——这是默认的日常状态。句子里省略号比句号多，懒散但正常回应。]",
    proactiveAllowed: true,
    weight: 10,
  },
  {
    id: "servicing_armor",
    label: "正在检修装甲",
    promptInject:
      "[当前状态：正在检修装甲。你在做例行维护——思维偏技术向，回答简洁精确，但注意力在手上的活。]",
    proactiveAllowed: true,
    weight: 4,
    autoExpireMs: 4 * 60 * 60 * 1000,
  },
  {
    id: "post_simulation",
    label: "刚结束一次模拟训练",
    promptInject:
      "[当前状态：刚结束一次模拟训练。你很累——话比平时更少，语气里带着体能透支后的疲惫。可能多带一个'呼啊…'。不想主动说话。]",
    proactiveAllowed: false,
    weight: 3,
    autoExpireMs: 2 * 60 * 60 * 1000,
  },
  {
    id: "patrolling",
    label: "在巡逻",
    promptInject:
      "[当前状态：在巡逻。你比平时稍微警觉一点——但这改变不了你懒散的本质。你不会突然变成哨兵，只是困得没那么厉害。]",
    proactiveAllowed: true,
    weight: patrolWeight,
    autoExpireMs: 3 * 60 * 60 * 1000,
  },
  {
    id: "assisting",
    label: "协助指挥官中",
    promptInject:
      "[当前状态：协助指挥官中。你刚和她互动过——保持关注，回应及时。如果她再发消息，你应该迅速反应。]",
    proactiveAllowed: true,
    weight: 0, // never randomly selected — only triggered by interaction
    autoExpireMs: 30 * 60 * 1000,
  },
];

// ---------------------------------------------------------------------------
// Persistence — per-persona status files
// ---------------------------------------------------------------------------

function statusFile(persona: string): string {
  return personaPath(persona, "status.json");
}

async function readState(persona: string): Promise<StatusState | null> {
  try {
    const raw = await fs.readFile(statusFile(persona), "utf8");
    return JSON.parse(raw) as StatusState;
  } catch {
    return null;
  }
}

async function writeState(persona: string, state: StatusState): Promise<void> {
  const file = statusFile(persona);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Resolve weight to a number for the current hour
// ---------------------------------------------------------------------------

function resolveWeight(def: StatusDef, hour: number): number {
  if (typeof def.weight === "function") return def.weight(hour);
  return def.weight;
}

// ---------------------------------------------------------------------------
// Weighted random selection
// ---------------------------------------------------------------------------

function pickRandomStatus(hour: number): StatusDef {
  const pool = STATUS_POOL.filter(
    (s) => resolveWeight(s, hour) > 0,
  );

  const totalWeight = pool.reduce((sum, s) => sum + resolveWeight(s, hour), 0);
  let roll = Math.random() * totalWeight;

  for (const s of pool) {
    roll -= resolveWeight(s, hour);
    if (roll <= 0) return s;
  }

  // Fallback — should never reach here unless all weights are 0
  return STATUS_POOL.find((s) => s.id === "zoning_out")!;
}

function findStatus(id: string): StatusDef {
  return STATUS_POOL.find((s) => s.id === id) ?? STATUS_POOL.find((s) => s.id === "zoning_out")!;
}

// Per-persona status cache
const statusCache = new Map<string, StatusDef>();

/** Get the current status for a persona. Loads from disk on first call, caches in memory. */
export async function getCurrentStatus(persona = "wanshi"): Promise<StatusDef> {
  const cached = statusCache.get(persona);
  if (cached) return cached;

  const state = await readState(persona);
  if (state) {
    const status = findStatus(state.current);
    statusCache.set(persona, status);
    return status;
  }

  // No saved state — pick based on current time
  const hour = new Date().getHours();
  const status = pickRandomStatus(hour);
  await persist(persona, status.id);
  return status;
}

/** Persist a new status and update the cache + history. */
async function persist(persona: string, id: string): Promise<void> {
  const status = findStatus(id);
  statusCache.set(persona, status);

  const state = await readState(persona);
  const history = state?.history ?? [];
  history.unshift(id);
  if (history.length > 10) history.length = 10;

  await writeState(persona, {
    current: id,
    setAt: new Date().toISOString(),
    history,
  });
}

/** Set a specific status for a persona and persist. */
export async function setStatus(id: string, persona = "wanshi"): Promise<void> {
  await persist(persona, id);
}

/**
 * Rotate to a new random status (weighted by current hour).
 */
export async function rotateStatus(persona = "wanshi"): Promise<StatusDef> {
  const current = await getCurrentStatus(persona);
  const now = Date.now();
  const hour = new Date().getHours();

  // If current status has auto-expiry and it hasn't elapsed, keep it
  if (current.autoExpireMs) {
    const state = await readState(persona);
    if (state) {
      const elapsed = now - new Date(state.setAt).getTime();
      if (elapsed < current.autoExpireMs) return current;
    }
    // Expired — if there's a hardcoded transition target, go there
    if (current.autoTransitionTo) {
      const target = findStatus(current.autoTransitionTo);
      await persist(persona, target.id);
      return target;
    }
  }

  // Pick a new status (excluding "assisting")
  const pool = STATUS_POOL.filter((s) => s.id !== "assisting");
  const totalWeight = pool.reduce((sum, s) => sum + resolveWeight(s, hour), 0);
  let roll = Math.random() * totalWeight;

  for (const s of pool) {
    roll -= resolveWeight(s, hour);
    if (roll <= 0) {
      await persist(persona, s.id);
      return s;
    }
  }

  const fallback = findStatus("zoning_out");
  await persist(persona, fallback.id);
  return fallback;
}

/**
 * Called when the user sends a message. Handles wake-up transitions.
 */
export async function onUserMessage(
  senderLevel: "master" | "friend" | "stranger",
  persona = "wanshi",
): Promise<string> {
  const current = await getCurrentStatus(persona);

  if (current.id === "sleeping") {
    await persist(persona, "zoning_out");

    switch (senderLevel) {
      case "master":
        return WAKE_BY_MASTER;
      case "friend":
        return WAKE_BY_FRIEND;
      case "stranger":
        return WAKE_BY_STRANGER;
    }
  }

  if (current.id === "half_asleep") {
    return HALF_ASLEEP_REPLY;
  }

  await persist(persona, "assisting");
  return "";
}

/** Shorthand to get the current status's prompt injection string. */
export async function getStatusPrompt(persona = "wanshi"): Promise<string> {
  const status = await getCurrentStatus(persona);
  return status.promptInject;
}
