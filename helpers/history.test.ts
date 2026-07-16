import { describe, expect, it, beforeEach, vi } from "vitest";
import * as fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// In-memory filesystem mock
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises");

const mockedFs = vi.mocked(fs);

/** In-memory file store so read-after-write works naturally. */
const store = new Map<string, string>();

function resetStore(files: Record<string, string> = {}): void {
  store.clear();
  for (const [k, v] of Object.entries(files)) store.set(k, v);
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();

  mockedFs.access.mockImplementation(async (p) => {
    const key = String(p);
    if (!store.has(key)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  mockedFs.readFile.mockImplementation(async (p) => {
    const key = String(p);
    const content = store.get(key);
    if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return content;
  });
  mockedFs.writeFile.mockImplementation(async (p, data) => {
    store.set(String(p), typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array));
  });
  mockedFs.appendFile.mockImplementation(async (p, data) => {
    const key = String(p);
    const existing = store.get(key) ?? "";
    const text = typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array);
    store.set(key, existing + text);
  });
  mockedFs.mkdir.mockResolvedValue(undefined as never);
  mockedFs.stat.mockResolvedValue({ mtimeMs: Date.now() } as never);
});

// ---------------------------------------------------------------------------
// Import after mock so the mocked fs is used
// ---------------------------------------------------------------------------

import { loadHistory, getHistory, pushHistoryMessage, clearHistory, estimateTokens } from "./history.js";

// ---------------------------------------------------------------------------
// estimateTokens (unchanged from original)
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("estimates pure ASCII at ~0.25 tokens per character", () => {
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });
  it("estimates pure Chinese at ~1.5 tokens per character", () => {
    expect(estimateTokens("你好世界你好世界你好")).toBe(15);
  });
  it("handles mixed Chinese + ASCII", () => {
    expect(estimateTokens("hello 你好世界")).toBe(8);
  });
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
  it("rounds up fractional token counts", () => {
    expect(estimateTokens("abc")).toBe(1);
  });
  it("handles large mixed-language text proportionally", () => {
    const cjk = "世".repeat(1000);
    const ascii = "a".repeat(1000);
    expect(estimateTokens(cjk + ascii)).toBe(1750);
  });
});

// ---------------------------------------------------------------------------
// loadHistory
// ---------------------------------------------------------------------------

describe("loadHistory", () => {
  const PATH = "/tmp/history.md";
  const FRONTMATTER = "---\ntags:\n  - elias\n---\n\n";

  it("parses single-line user and assistant messages", async () => {
    resetStore({
      [PATH]: FRONTMATTER + [
        "[2026-06-24 15:00:00] 漓琊 (Master): hello",
        "[2026-06-24 15:00:05] wanshi: hi there",
      ].join("\n"),
    });

    const msgs = await loadHistory(PATH);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: "user", content: "hello" });
    expect(msgs[1]).toEqual({ role: "assistant", content: "hi there" });
  });

  it("joins continuation lines into the previous message", async () => {
    resetStore({
      [PATH]: FRONTMATTER + [
        "[2026-06-24 15:26:25] 漓琊 (Master): 第一部分（昨天 17:55 - 18:12）",
        "聊天对象：死党小韩",
        "",
        "昨天 17:55",
        "我：OK呀，今天很幸福的一件事是。",
        "[2026-06-24 15:26:30] wanshi: got it",
      ].join("\n"),
    });

    const msgs = await loadHistory(PATH);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.content).toBe(
      "第一部分（昨天 17:55 - 18:12）\n聊天对象：死党小韩\n昨天 17:55\n我：OK呀，今天很幸福的一件事是。"
    );
    expect(msgs[1]!.content).toBe("got it");
  });

  it("preserves blank lines within message content", async () => {
    resetStore({
      [PATH]: FRONTMATTER + [
        "[2026-06-24 15:00:00] 漓琊 (Master): line one",
        "",
        "line two",
        "[2026-06-24 15:00:05] wanshi: ok",
      ].join("\n"),
    });

    const msgs = await loadHistory(PATH);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.content).toBe("line one\nline two");
  });

  it("returns empty array for empty body", async () => {
    resetStore({ [PATH]: FRONTMATTER });
    const msgs = await loadHistory(PATH);
    expect(msgs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// session cache (getHistory / pushHistoryMessage / clearHistory)
// ---------------------------------------------------------------------------

describe("session cache", () => {
  const PATH = "/tmp/cache.md";
  const FRONTMATTER = "---\ntags:\n  - elias\n---\n\n";

  beforeEach(async () => {
    // Reset fs store + clear the module-level cache for this path
    await clearHistory(PATH);
  });

  it("cold start — loads from file on first access", async () => {
    resetStore({
      [PATH]: FRONTMATTER + "[2026-06-24 15:00:00] 漓琊 (Master): cold start msg",
    });

    const msgs = await getHistory(PATH);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe("cold start msg");
  });

  it("cache hit — second access returns same reference, no re-read", async () => {
    resetStore({
      [PATH]: FRONTMATTER + "[2026-06-24 15:00:00] 漓琊 (Master): first",
    });

    const first = await getHistory(PATH);
    const readCount = mockedFs.readFile.mock.calls.length;

    const second = await getHistory(PATH);
    expect(second).toBe(first);
    expect(mockedFs.readFile.mock.calls.length).toBe(readCount);
  });

  it("pushHistoryMessage into empty cache — no file read needed", async () => {
    // clearHistory in beforeEach already touched readFile — snapshot the count
    const callsBefore = mockedFs.readFile.mock.calls.length;

    pushHistoryMessage(PATH, { role: "user", content: "pushed" });

    const msgs = await getHistory(PATH);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe("pushed");
    // No additional reads — the message came from cache
    expect(mockedFs.readFile.mock.calls.length).toBe(callsBefore);
  });

  it("pushHistoryMessage appends to existing cache", async () => {
    resetStore({
      [PATH]: FRONTMATTER + "[2026-06-24 15:00:00] 漓琊 (Master): existing",
    });

    await getHistory(PATH); // cold start
    pushHistoryMessage(PATH, { role: "assistant", content: "reply" });

    const msgs = await getHistory(PATH);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.content).toBe("existing");
    expect(msgs[1]!.content).toBe("reply");
  });

  it("clearHistory clears cache — next getHistory reloads from file", async () => {
    resetStore({
      [PATH]: FRONTMATTER + "[2026-06-24 15:00:00] 漓琊 (Master): before clear",
    });

    const before = await getHistory(PATH);
    expect(before).toHaveLength(1);

    await clearHistory(PATH);

    // File is now empty
    const after = await getHistory(PATH);
    expect(after).toHaveLength(0);
  });
});
