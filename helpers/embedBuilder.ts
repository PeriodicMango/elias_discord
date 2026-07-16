import { EmbedBuilder } from "discord.js";

// ---------------------------------------------------------------------------
// Per-persona embed colors
// ---------------------------------------------------------------------------

const PERSONA_COLORS: Record<string, number> = {
  wanshi: 0x4A90D9, // soft ice-blue
  elias: 0x8B0000, // dark red — SYN-03 bioweapon
  raw: 0x6B7280, // neutral gray
};

// ---------------------------------------------------------------------------
// Build status card embed (compact single-line)
// ---------------------------------------------------------------------------

/**
 * Build a compact Discord embed showing the persona's mood and/or tools used.
 *
 * Returns `undefined` when both are absent — callers should skip the embed.
 */
export function buildStatusEmbed(
  persona: string,
  mood?: string | null,
  toolsUsed?: string[] | null,
): EmbedBuilder | undefined {
  const hasMood = mood && mood.trim().length > 0;
  const hasTools = toolsUsed && toolsUsed.length > 0;

  if (!hasMood && !hasTools) return undefined;

  const parts: string[] = [];
  if (hasMood) parts.push(`🧠 ${mood!}`);
  if (hasTools) {
    const labels = toolsUsed!.map((t) => `\`${t}\``).join(" ");
    parts.push(`🔧 ${labels}`);
  }

  return new EmbedBuilder()
    .setColor(PERSONA_COLORS[persona] ?? 0x808080)
    .setDescription(parts.join("　"));
}
