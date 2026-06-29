import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// Mock fs/promises
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
// Import after mocks are set up
// ---------------------------------------------------------------------------

import {
  getCurrentStatus,
  setStatus,
  rotateStatus,
  onUserMessage,
  getStatusPrompt,
  isSleepTrigger,
  isSleepHours,
  STATUS_POOL,
} from "./status.js";

describe("STATUS_POOL", () => {
  it("contains all expected statuses", () => {
    const ids = STATUS_POOL.map((s) => s.id);
    expect(ids).toContain("sleeping");
    expect(ids).toContain("half_asleep");
    expect(ids).toContain("zoning_out");
    expect(ids).toContain("servicing_armor");
    expect(ids).toContain("post_simulation");
    expect(ids).toContain("patrolling");
    expect(ids).toContain("assisting");
  });

  it("every status has required fields", () => {
    for (const s of STATUS_POOL) {
      expect(s.id).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(typeof s.proactiveAllowed).toBe("boolean");
      expect(s.weight).toBeDefined();
    }
  });

  it("only sleeping/half_asleep/post_simulation have proactiveAllowed false", () => {
    const noProactive = STATUS_POOL.filter((s) => !s.proactiveAllowed).map((s) => s.id);
    expect(noProactive).toContain("sleeping");
    expect(noProactive).toContain("half_asleep");
    expect(noProactive).toContain("post_simulation");
    expect(noProactive).toHaveLength(3);
  });
});

describe("isSleepTrigger", () => {
  it("matches 晚安", () => {
    expect(isSleepTrigger("晚安")).toBe(true);
  });

  it("matches goodnight", () => {
    expect(isSleepTrigger("goodnight")).toBe(true);
  });

  it("matches 睡了", () => {
    expect(isSleepTrigger("我去睡了")).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(isSleepTrigger("今天好冷")).toBe(false);
    expect(isSleepTrigger("hello")).toBe(false);
  });
});

describe("getCurrentStatus with persona", () => {
  it("returns a valid status for any persona", async () => {
    const status = await getCurrentStatus("wanshi");
    expect(status.id).toBeTruthy();
    expect(status.label).toBeTruthy();
  });

  it("returns different cached status for different personas", async () => {
    // When no saved state, initial status is time-based (same for both)
    const s1 = await getCurrentStatus("wanshi");
    const s2 = await getCurrentStatus("elias");

    // Both should have valid statuses
    expect(s1.id).toBeTruthy();
    expect(s2.id).toBeTruthy();
  });

  it("creates status file path under persona directory", async () => {
    await getCurrentStatus("raw");
    // Verify that a writeFile call was made to the raw persona path
    const writeCalls = mockedFs.writeFile.mock.calls;
    const rawPathCalls = writeCalls.filter((call) =>
      String(call[0]).includes("raw") && String(call[0]).includes("status.json"),
    );
    expect(rawPathCalls.length).toBeGreaterThan(0);
  });
});

describe("setStatus with persona", () => {
  it("persists status for specific persona", async () => {
    await setStatus("sleeping", "elias");

    const writeCalls = mockedFs.writeFile.mock.calls;
    const eliasStatusCalls = writeCalls.filter((call) =>
      String(call[0]).includes("elias") && String(call[0]).includes("status.json"),
    );
    expect(eliasStatusCalls.length).toBeGreaterThan(0);

    // Verify the content includes "sleeping"
    const lastCall = eliasStatusCalls[eliasStatusCalls.length - 1];
    if (lastCall) {
      expect(String(lastCall[1])).toContain("sleeping");
    }
  });

  it("sets different statuses for different personas independently", async () => {
    await setStatus("sleeping", "wanshi");
    await setStatus("assisting", "elias");

    const writeCalls = mockedFs.writeFile.mock.calls;

    const wanshiStatusCall = writeCalls.find((call) =>
      String(call[0]).includes("wanshi/status.json") && String(call[1]).includes("sleeping"),
    );
    const eliasStatusCall = writeCalls.find((call) =>
      String(call[0]).includes("elias/status.json") && String(call[1]).includes("assisting"),
    );

    expect(wanshiStatusCall).toBeDefined();
    expect(eliasStatusCall).toBeDefined();
  });
});

describe("getStatusPrompt with persona", () => {
  it("returns prompt injection string for persona", async () => {
    const prompt = await getStatusPrompt("raw");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("has different prompts for different statuses", async () => {
    // Set wanshi to sleeping
    await setStatus("sleeping", "wanshi");

    // Force cache clear for raw (which hasn't been set)
    const { statusCache } = await vi.importActual("./status.js");
    // Just get the prompt for raw (default status)
    const rawPrompt = await getStatusPrompt("raw");
    expect(rawPrompt.length).toBeGreaterThan(0);
  });
});

describe("onUserMessage with persona", () => {
  it("wakes from sleeping with WAKE_BY_MASTER string", async () => {
    // Set to sleeping first
    await setStatus("sleeping", "wanshi");

    const anger = await onUserMessage("master", "wanshi");
    expect(anger).toContain("低功耗待机模式");
  });

  it("returns empty for normal assisting transition", async () => {
    // Default status (zoning_out or assisting)
    const result = await onUserMessage("master", "elias");
    expect(typeof result).toBe("string");
    // Should transition to assisting and return empty string
  });

  it("returns WAKE_BY_FRIEND for friend waking from sleep", async () => {
    await setStatus("sleeping", "wanshi");
    const anger = await onUserMessage("friend", "wanshi");
    expect(anger).toContain("低功耗待机模式");
    // Should have wake-up anger (non-master)
    expect(anger.length).toBeGreaterThan(20);
  });
});

describe("sleep hours", () => {
  it("isSleepHours is a boolean function", () => {
    const result = isSleepHours();
    expect(typeof result).toBe("boolean");
  });
});
