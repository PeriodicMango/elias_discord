import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initAuth,
  getMasterId,
  setMasterId,
  isMaster,
  clearMasterCache,
} from "../helpers/auth.js";

// Test fixture: create temp dir with optional data.json
function setup(data?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "elias-auth-test-"));
  if (data) {
    writeFileSync(join(dir, "data.json"), JSON.stringify(data, null, 2), "utf8");
  }
  return dir;
}

function teardown(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe("auth", () => {
  let dir: string;

  beforeEach(() => {
    dir = setup();
    clearMasterCache();
  });

  afterEach(() => {
    teardown(dir);
    clearMasterCache();
  });

  describe("getMasterId", () => {
    it("returns empty when no master set", async () => {
      initAuth({ baseDir: dir, masterId: "", masterTag: "" });
      expect(await getMasterId()).toBe("");
    });

    it("returns env masterId when data.json has none", async () => {
      initAuth({ baseDir: dir, masterId: "env-123", masterTag: "tag" });
      const id = await getMasterId();
      expect(id).toBe("env-123");
    });

    it("persists env masterId to data.json", async () => {
      initAuth({ baseDir: dir, masterId: "env-456", masterTag: "tag" });
      await getMasterId();

      // Should now be in data.json
      const fs = await import("node:fs/promises");
      const raw = await fs.readFile(join(dir, "data.json"), "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.masterId).toBe("env-456");
    });

    it("prefers data.json over env masterId", async () => {
      writeFileSync(join(dir, "data.json"), JSON.stringify({ masterId: "disk-789" }), "utf8");
      initAuth({ baseDir: dir, masterId: "env-000", masterTag: "tag" });
      expect(await getMasterId()).toBe("disk-789");
    });
  });

  describe("setMasterId", () => {
    it("sets master ID when none exists", async () => {
      initAuth({ baseDir: dir, masterId: "", masterTag: "" });
      const result = await setMasterId("first-123");
      expect(result).toBe(true);
      expect(await getMasterId()).toBe("first-123");
    });

    it("rejects after master is already locked", async () => {
      initAuth({ baseDir: dir, masterId: "env-123", masterTag: "tag" });
      await getMasterId(); // locks it in
      const result = await setMasterId("hijack-456");
      expect(result).toBe(false);
      expect(await getMasterId()).toBe("env-123");
    });
  });

  describe("isMaster", () => {
    it("returns true for the master", async () => {
      initAuth({ baseDir: dir, masterId: "master-id", masterTag: "tag" });
      expect(await isMaster("master-id")).toBe(true);
    });

    it("returns false for non-master", async () => {
      initAuth({ baseDir: dir, masterId: "master-id", masterTag: "tag" });
      expect(await isMaster("rando")).toBe(false);
    });
  });
});
