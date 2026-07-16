import { readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Initialization — called once by EliasBrain constructor
// ---------------------------------------------------------------------------

let _baseDir = "";
let _envMasterId = "";
let _envMasterTag = "";

export function initAuth(opts: { baseDir: string; masterId: string; masterTag: string }): void {
  _baseDir = opts.baseDir;
  _envMasterId = opts.masterId;
  _envMasterTag = opts.masterTag;
  cachedMasterId = undefined;
  cachedMasterTag = undefined;
}

// ---------------------------------------------------------------------------
// Auto-master system
// ---------------------------------------------------------------------------

let cachedMasterId: string | undefined = undefined;
let cachedMasterTag: string | undefined = undefined;

async function readDataJson(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path.join(_baseDir, "data.json"), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeDataJson(data: Record<string, unknown>): Promise<void> {
  const dataFile = path.join(_baseDir, "data.json");
  try { await writeFile(dataFile, JSON.stringify(data, null, 2), "utf8"); } catch (err) { console.error("writeDataJson failed:", err); }
}

async function readMasterIdFromData(): Promise<string | null> {
  const data = await readDataJson();
  return (data.masterId as string) ?? null;
}

async function writeMasterIdToData(id: string): Promise<void> {
  const data = await readDataJson();
  data.masterId = id;
  await writeDataJson(data);
}

export async function getMasterId(): Promise<string> {
  if (cachedMasterId !== undefined) return cachedMasterId;

  const fromData = await readMasterIdFromData();
  if (fromData) {
    cachedMasterId = fromData;
    return fromData;
  }

  if (_envMasterId) {
    await writeMasterIdToData(_envMasterId);
    cachedMasterId = _envMasterId;
    return _envMasterId;
  }

  return "";
}

export async function getMasterTag(): Promise<string> {
  if (cachedMasterTag !== undefined) return cachedMasterTag;

  const data = await readDataJson();
  const masterSecret = data.masterSecret as string | undefined;
  const masterId = await getMasterId();

  if (masterSecret && masterId) {
    const tag = crypto
      .createHmac("sha256", masterSecret)
      .update(masterId)
      .digest("hex")
      .slice(0, 16);
    cachedMasterTag = tag;
    return tag;
  }

  cachedMasterTag = _envMasterTag;
  return _envMasterTag;
}

export async function setMasterId(id: string): Promise<boolean> {
  const existing = await getMasterId();
  if (existing) return false;
  await writeMasterIdToData(id);
  cachedMasterId = id;
  console.log(`[SYSTEM LOG] Master locked in as: ${id}`);
  return true;
}

export async function transferMaster(newId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const current = await getMasterId();
  if (!current) return { ok: false, error: "没有已设置的 Master。" };
  if (!/^\d{17,20}$/.test(newId)) {
    return { ok: false, error: "无效的 Discord 用户 ID（应为 17-20 位数字）。" };
  }

  const newSecret = crypto.randomBytes(32).toString("hex");
  const data = await readDataJson();
  data.masterId = newId;
  data.masterSecret = newSecret;
  await writeDataJson(data);

  cachedMasterId = newId;
  cachedMasterTag = undefined;
  clearMasterCache();

  console.log(`[SYSTEM LOG] Master transferred: ${current} → ${newId} (tag rotated)`);
  return { ok: true };
}

export async function isMaster(id: string): Promise<boolean> {
  const masterId = await getMasterId();
  return masterId !== "" && id === masterId;
}

export function clearMasterCache(): void {
  cachedMasterId = undefined;
  cachedMasterTag = undefined;
}
