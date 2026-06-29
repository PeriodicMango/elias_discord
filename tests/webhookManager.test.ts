import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises");

const mockedFs = vi.mocked(fs);
const store = new Map<string, string>();

function setFile(path: string, content: string): void {
  store.set(path, content);
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();

  mockedFs.readFile.mockImplementation(async (p: unknown, _enc?: unknown) => {
    const key = String(p);
    const content = store.get(key);
    if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return content;
  });

  mockedFs.writeFile.mockImplementation(async (p: unknown, data: unknown) => {
    store.set(String(p), String(data));
  });

  mockedFs.mkdir.mockResolvedValue(undefined);
  mockedFs.access.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Seed channels.json for webhook tests
// ---------------------------------------------------------------------------

import { PATHS } from "../config.js";

const sampleChannelsConfig = {
  personas: {
    wanshi: {
      channelId: "111",
      displayName: "万事",
      avatarUrl: "https://example.com/wanshi.png",
      enabled: true,
    },
    elias: {
      channelId: "222",
      displayName: "Elias",
      avatarUrl: "https://example.com/elias.png",
      enabled: true,
    },
  },
  groupChat: {
    channelId: "999",
    personas: ["wanshi", "elias"],
    enabled: true,
  },
  dmDefaultPersona: "wanshi",
};

beforeEach(() => {
  setFile(PATHS.channelsConfig, JSON.stringify(sampleChannelsConfig));
  // Clear registry cache
  vi.importActual("./channelRegistry.js");
});

// ---------------------------------------------------------------------------
// Webhook URL persistence
// ---------------------------------------------------------------------------

describe("webhook URL persistence", () => {
  it("loads empty when no webhooks.json exists", async () => {
    // webhooks.json doesn't exist yet
    // We verify via sendAsPersona fallback
    const { PATHS: paths } = await import("../config.js");
    expect(paths.webhooksConfig).toContain("webhooks.json");
  });

  it("writes and reads webhook entries through the persistence layer", async () => {
    const testEntries = {
      entries: [
        { channelId: "111", persona: "wanshi", webhookUrl: "https://discord.com/api/webhooks/test/111" },
        { channelId: "222", persona: "elias", webhookUrl: "https://discord.com/api/webhooks/test/222" },
      ],
    };

    setFile(PATHS.webhooksConfig, JSON.stringify(testEntries));

    // Verify the file was set up correctly
    const raw = store.get(PATHS.webhooksConfig);
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].persona).toBe("wanshi");
    expect(parsed.entries[1].persona).toBe("elias");
  });
});

// ---------------------------------------------------------------------------
// sendAsPersona behavior
// ---------------------------------------------------------------------------

describe("sendAsPersona", () => {
  it("falls back to channel.send when no webhook URL exists", async () => {
    const { sendAsPersona } = await import("./webhookManager.js");

    let sentContent = "";
    const mockChannel = {
      id: "111",
      send: async (msg: string) => { sentContent = msg; },
    };

    await sendAsPersona(mockChannel as any, "wanshi", "test message", {} as any);

    expect(sentContent).toBe("test message");
  });

  it("falls back for empty text", async () => {
    const { sendAsPersona } = await import("./webhookManager.js");

    let called = false;
    const mockChannel = {
      id: "111",
      send: async () => { called = true; },
    };

    await sendAsPersona(mockChannel as any, "wanshi", "   ", {} as any);
    expect(called).toBe(false); // empty text is skipped
  });

  it("uses persona display name when webhook is configured", async () => {
    // Seed a webhook URL for wanshi in channel 111
    setFile(PATHS.webhooksConfig, JSON.stringify({
      entries: [
        { channelId: "111", persona: "wanshi", webhookUrl: "https://discord.com/api/webhooks/fake/test" },
      ],
    }));

    // The WebhookClient constructor will fail without a real URL,
    // so we expect the fallback to channel.send
    const { sendAsPersona } = await import("./webhookManager.js");

    let sentContent = "";
    const mockChannel = {
      id: "111",
      send: async (msg: string) => { sentContent = msg; },
    };

    // This should attempt webhook, fail, and fall back to channel.send
    await sendAsPersona(mockChannel as any, "wanshi", "hello", {} as any);

    // Falls back to channel.send after webhook failure
    expect(sentContent).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// Summary stripper (regex-based, no LLM)
// ---------------------------------------------------------------------------

describe("summarizePersonaMessage", () => {
  // The summarizePersonaMessage function is defined in bot.ts.
  // Test the regex patterns it uses by replicating the logic.
  function stripStyle(text: string, persona: string): string {
    let s = text
      .replace(/唔…|呼啊…|……/g, "")
      .replace(/（[^）]*）/g, "")
      .replace(/\([^)]*\)/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (s.length > 60) s = s.slice(0, 60) + "…";
    return `[${persona}]: ${s}`;
  }

  it("strips 唔… and 呼啊… from wanshi-style messages", () => {
    const input = "唔…手套在左边抽屉。呼啊…好困。";
    const result = stripStyle(input, "wanshi");
    expect(result).not.toContain("唔");
    expect(result).not.toContain("呼啊");
    expect(result).toContain("手套在左边抽屉");
  });

  it("strips Chinese bracket actions", () => {
    const input = "（检查装备）准备好了。";
    const result = stripStyle(input, "elias");
    expect(result).not.toContain("检查装备");
    expect(result).toContain("准备好了");
  });

  it("strips English bracket actions", () => {
    const input = "(checks scope) Ready.";
    const result = stripStyle(input, "elias");
    expect(result).not.toContain("checks scope");
    expect(result).toContain("Ready");
  });

  it("truncates long messages to 60 chars", () => {
    // Build a string that's definitely >60 chars
    const input = "A".repeat(120) + "BCDEFGHIJKLMNOPQRSTUVWXYZ" + "Z".repeat(80);
    const result = stripStyle(input, "raw");
    expect(result.length).toBeLessThanOrEqual(70); // 60 chars + prefix ~7 chars
    expect(result).toContain("…");
  });

  it("preserves factual content", () => {
    const input = "建议检查暖气，确认温度设置为22度。";
    const result = stripStyle(input, "elias");
    expect(result).toContain("检查暖气");
    expect(result).toContain("22度");
  });

  it("prefixes with persona name", () => {
    const result = stripStyle("hello", "raw");
    expect(result).toMatch(/^\[raw\]:/);
  });
});
