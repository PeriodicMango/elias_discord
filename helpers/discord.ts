import type { EmbedBuilder, Message, TextBasedChannel } from "discord.js";
import { FRIEND_IDS } from "../config.js";
import { getMasterId, isMaster as authIsMaster } from "./auth.js";
import { getMasterTitle, getPersonaTriggers, getPersonaTitle } from "./personas.js";

/**
 * Resolve the title a persona uses to address the master (e.g. "指挥官", "主人", "").
 * Reads from persona file's YAML frontmatter `master_title:` field.
 */
export async function masterTitle(persona?: string): Promise<string> {
  if (!persona) return "";
  return getMasterTitle(persona);
}

export { authIsMaster as isMaster };

function isFriend(id: string): boolean {
  return FRIEND_IDS.includes(id);
}

export async function classifySender(
  authorId: string,
  authorName: string,
): Promise<{ sender: string; level: "master" | "friend" | "stranger" }> {
  if (await authIsMaster(authorId)) {
    return { sender: "漓琊 (Master)", level: "master" };
  }
  if (isFriend(authorId)) {
    return { sender: `${authorName} (Friend)`, level: "friend" };
  }
  return { sender: `${authorName} (Stranger)`, level: "stranger" };
}

export async function rewriteMentions(content: string, selfId: string, persona?: string): Promise<string> {
  const title = await masterTitle(persona);
  const selfLabel = persona ? await getPersonaTitle(persona) : "Elias";
  const masterId = await getMasterId();
  return content.replace(/<@!?(\d+)>/g, (_, idStr: string) => {
    if (masterId && idStr === masterId) return `提及：你的${title}漓琊`;
    if (idStr === selfId) return `提及：你(${selfLabel})`;
    if (FRIEND_IDS.includes(idStr)) return `提及：${title}的朋友`;
    return "提及：陌生人";
  });
}

async function triggerPattern(persona?: string): Promise<RegExp> {
  if (!persona) return /elias/i;
  const triggers = await getPersonaTriggers(persona);
  const escaped = triggers.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("|"), "i");
}

export async function shouldRespond(message: Message, selfId: string, persona?: string): Promise<boolean> {
  if (message.channel.isDMBased()) return true;
  // In a persona's own channel, always respond to non-bot messages
  if (persona) {
    const { getPersonaForChannel } = await import("./channelRegistry.js");
    const owner = await getPersonaForChannel(message.channel.id);
    if (owner === persona) return true;
    // Also respond in group chat
    const { isGroupChatChannel } = await import("./channelRegistry.js");
    if (await isGroupChatChannel(message.channel.id)) return true;
  }
  if ((await triggerPattern(persona)).test(message.content)) return true;
  return message.mentions.has(selfId);
}

export async function sendReply(
  channel: TextBasedChannel,
  text: string,
  embed?: EmbedBuilder,
): Promise<void> {
  if (!("send" in channel) || typeof channel.send !== "function") return;
  if (embed) {
    await channel.send({ content: text, embeds: [embed] });
  } else {
    await channel.send(text);
  }
}

/** Fetch partial message & channel (required for uncached DMs). */
export async function ensureComplete(message: Message): Promise<void> {
  if (message.partial) await message.fetch().catch(() => {});
  if ("partial" in message.channel && message.channel.partial) {
    await ((message.channel as unknown as { fetch: () => Promise<unknown> }).fetch?.().catch(() => {}));
  }
}
