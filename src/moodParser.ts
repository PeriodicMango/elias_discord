// ---------------------------------------------------------------------------
// Parse [心情: xxx] mood tag from model reply text
// ---------------------------------------------------------------------------

const MOOD_TAG_RE = /^\[心情\s*[:：]\s*([^\]]+)\]/;

export interface MoodParseResult {
  /** The extracted mood word, or null if no tag was present. */
  mood: string | null;
  /** The text with the mood tag stripped. */
  text: string;
}

/**
 * Extract and strip a `[心情: <mood>]` tag from the start of the model's reply.
 *
 * The tag must appear at the very beginning of the text. It is removed from
 * the returned text so it doesn't leak into the visible Discord message.
 * Half-width and full-width colons are both accepted.
 */
export function parseMoodTag(raw: string): MoodParseResult {
  const match = raw.match(MOOD_TAG_RE);
  if (match) {
    return {
      mood: match[1]!.trim(),
      text: raw.replace(match[0], "").trim(),
    };
  }
  return { mood: null, text: raw };
}
