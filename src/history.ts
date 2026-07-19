// ---------------------------------------------------------------------------
// Per-user chat history — pure in-memory Map, restarts lose it (ADR-0002).
// Jiwen segment analysis will plug in here later.
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

const MAX_HISTORY = 50;

const store = new Map<string, HistoryEntry[]>();

export function getHistory(userId: string): HistoryEntry[] {
  return store.get(userId) ?? [];
}

export function appendHistory(userId: string, entry: HistoryEntry): void {
  let list = store.get(userId);
  if (!list) {
    list = [];
    store.set(userId, list);
  }
  list.push(entry);
  if (list.length > MAX_HISTORY) {
    list.splice(0, list.length - MAX_HISTORY);
  }
}
