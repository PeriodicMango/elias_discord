import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// Mock fs/promises so the tests don't touch the real filesystem
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
  mockedFs.access.mockImplementation(async (p: unknown) => {
    if (!store.has(String(p))) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
});

// ---------------------------------------------------------------------------
// Path helpers (config.ts)
// ---------------------------------------------------------------------------

import { personaPath, sharedPath, PATHS } from "../config.js";

describe("personaPath", () => {
  it("returns per-persona path under elias_data/Elias/{persona}", () => {
    const result = personaPath("wanshi", "daily_log");
    expect(result).toContain("elias_data/Elias/wanshi/daily_log");
    expect(result).toContain("elias"); // parent dir name
  });

  it("joins multiple segments", () => {
    const result = personaPath("elias", "history", "dm.md");
    expect(result).toContain("elias_data/Elias/elias/history/dm.md");
  });

  it("works for raw persona", () => {
    const result = personaPath("raw", "status.json");
    expect(result).toContain("elias_data/Elias/raw/status.json");
  });
});

describe("sharedPath", () => {
  it("returns shared path under elias_data/Elias/shared", () => {
    const result = sharedPath("kb");
    expect(result).toContain("elias_data/Elias/shared/kb");
  });

  it("accepts multiple segments", () => {
    const result = sharedPath("persona-memory", "wanshi", "notebook.md");
    expect(result).toContain("elias_data/Elias/shared/persona-memory/wanshi/notebook.md");
  });
});

describe("PATHS", () => {
  it("eliasKnowledge points to shared kb/", () => {
    expect(PATHS.eliasKnowledge).toContain("shared/kb");
  });

  it("channelsConfig exists", () => {
    expect(PATHS.channelsConfig).toContain("config/channels.json");
  });

  it("webhooksConfig exists", () => {
    expect(PATHS.webhooksConfig).toContain("config/webhooks.json");
  });
});

describe("listPersonas", () => {
  it("returns an array", async () => {
    const { listPersonas, clearPersonaCache } = await import("./personas.js");
    clearPersonaCache(); // ensure fresh read
    const personas = await listPersonas();
    expect(Array.isArray(personas)).toBe(true);
    // Note: count depends on personas/*.md files present in the project
  });
});

// ---------------------------------------------------------------------------
// channelRegistry.ts
// ---------------------------------------------------------------------------

import {
  loadChannels,
  saveChannels,
  getPersonaForChannel,
  getChannelForPersona,
  getEnabledPersonas,
  getGroupChatPersonas,
  isGroupChatChannel,
  getDmPersona,
  clearChannelCache,
  getPersonaConfig,
} from "./channelRegistry.js";

describe("channelRegistry", () => {
  const sampleConfig = {
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
      raw: {
        channelId: "333",
        displayName: "Raw",
        avatarUrl: "",
        enabled: true,
      },
    },
    groupChat: {
      channelId: "999",
      personas: ["wanshi", "elias", "raw"],
      enabled: true,
    },
    dmDefaultPersona: "wanshi",
  };

  beforeEach(async () => {
    clearChannelCache();
    // Seed the channels config file
    setFile(PATHS.channelsConfig, JSON.stringify(sampleConfig));
  });

  describe("loadChannels", () => {
    it("loads and parses channels.json", async () => {
      const cfg = await loadChannels();
      expect(cfg.dmDefaultPersona).toBe("wanshi");
      expect(cfg.personas.wanshi?.channelId).toBe("111");
    });

    it("returns fallback when file is missing", async () => {
      store.delete(PATHS.channelsConfig);
      const cfg = await loadChannels();
      expect(cfg.dmDefaultPersona).toBe("elias"); // fallback
      expect(Object.keys(cfg.personas)).toHaveLength(0);
    });

    it("caches results", async () => {
      const a = await loadChannels();
      const b = await loadChannels();
      expect(a).toBe(b); // same reference = cached
    });
  });

  describe("getPersonaForChannel", () => {
    it("returns wanshi for channel 111", async () => {
      expect(await getPersonaForChannel("111")).toBe("wanshi");
    });

    it("returns elias for channel 222", async () => {
      expect(await getPersonaForChannel("222")).toBe("elias");
    });

    it("returns raw for channel 333", async () => {
      expect(await getPersonaForChannel("333")).toBe("raw");
    });

    it("returns null for unknown channel", async () => {
      expect(await getPersonaForChannel("000")).toBeNull();
    });

    it("returns null for disabled persona", async () => {
      const cfgWithDisabled = {
        ...sampleConfig,
        personas: {
          ...sampleConfig.personas,
          wanshi: { ...sampleConfig.personas.wanshi, enabled: false },
        },
      };
      store.set(PATHS.channelsConfig, JSON.stringify(cfgWithDisabled));
      clearChannelCache();
      expect(await getPersonaForChannel("111")).toBeNull();
    });
  });

  describe("getChannelForPersona", () => {
    it("returns channel ID for valid persona", async () => {
      expect(await getChannelForPersona("wanshi")).toBe("111");
    });

    it("returns null for unknown persona", async () => {
      expect(await getChannelForPersona("nonexistent")).toBeNull();
    });
  });

  describe("getEnabledPersonas", () => {
    it("returns all enabled persona names", async () => {
      const names = await getEnabledPersonas();
      expect(names).toContain("wanshi");
      expect(names).toContain("elias");
      expect(names).toContain("raw");
      expect(names).toHaveLength(3);
    });
  });

  describe("getPersonaConfig", () => {
    it("returns config for a persona", async () => {
      const cfg = await getPersonaConfig("wanshi");
      expect(cfg?.displayName).toBe("万事");
      expect(cfg?.avatarUrl).toContain("wanshi.png");
    });

    it("returns null for unknown persona", async () => {
      expect(await getPersonaConfig("unknown")).toBeNull();
    });
  });

  describe("group chat", () => {
    it("getGroupChatPersonas returns all three", async () => {
      expect(await getGroupChatPersonas()).toEqual(["wanshi", "elias", "raw"]);
    });

    it("isGroupChatChannel returns true for group channel", async () => {
      expect(await isGroupChatChannel("999")).toBe(true);
    });

    it("isGroupChatChannel returns false for persona channel", async () => {
      expect(await isGroupChatChannel("111")).toBe(false);
    });

    it("returns empty and null when disabled", async () => {
      const disabled = {
        ...sampleConfig,
        groupChat: { ...sampleConfig.groupChat, enabled: false },
      };
      store.set(PATHS.channelsConfig, JSON.stringify(disabled));
      clearChannelCache();
      expect(await isGroupChatChannel("999")).toBe(false);
      expect(await getGroupChatPersonas()).toEqual([]);
    });
  });

  describe("getPersonaForChannel", () => {
    it("returns persona for a mapped channel", async () => {
      expect(await getPersonaForChannel("111")).toBe("wanshi");
    });

    it("returns null for an unmapped channel", async () => {
      expect(await getPersonaForChannel("000")).toBeNull();
    });
  });

  describe("getDmPersona", () => {
    it("returns dmDefaultPersona from config", async () => {
      expect(await getDmPersona()).toBe("wanshi");
    });

    it("fallback when config missing", async () => {
      store.delete(PATHS.channelsConfig);
      clearChannelCache();
      expect(await getDmPersona()).toBe("elias");
    });
  });
});

// ---------------------------------------------------------------------------
// tempHistoryPath (history.ts)
// ---------------------------------------------------------------------------

import { tempHistoryPath } from "./history.js";

describe("tempHistoryPath", () => {
  it("returns persona-specific DM path", () => {
    const channel = { id: "dm123", isDMBased: () => true };
    const result = tempHistoryPath(channel, "wanshi");
    expect(result).toContain("wanshi/history/dm.md");
  });

  it("returns persona-specific server channel path", () => {
    const channel = { id: "abc123", isDMBased: () => false };
    const result = tempHistoryPath(channel, "elias");
    expect(result).toContain("elias/history/server-abc123.md");
  });

  it("defaults to wanshi persona", () => {
    const channel = { id: "dm456", isDMBased: () => true };
    const result = tempHistoryPath(channel); // no persona arg
    expect(result).toContain("wanshi/history/dm.md");
  });

  it("works for raw persona", () => {
    const channel = { id: "ch789", isDMBased: () => false };
    const result = tempHistoryPath(channel, "raw");
    expect(result).toContain("raw/history/server-ch789.md");
  });
});
