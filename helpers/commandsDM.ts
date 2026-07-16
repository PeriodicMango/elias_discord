import type { Message } from "discord.js";
import { appendDailyLogRaw, timeString } from "../memory.js";
import { clearHistory, tempHistoryPath } from "./history.js";
import { runUserUpdate } from "./userUpdate.js";
import { sendReply } from "./discord.js";
import fs from "node:fs/promises";
import path from "node:path";
import { PATHS } from "../config.js";
import { parseDuration, switchPersona } from "./commands.js";
import { manageGoals } from "./tools/executors/goals.js";
import { getProactiveDisabledPersonas, setPersonaProactiveDisabled } from "./proactive.js";
import { getMasterId } from "./auth.js";
import { listPersonas, getPersonaTriggers } from "./personas.js";

async function setPaused(until: string | null): Promise<void> {
  const dataFile = path.join(PATHS.base, "data.json");
  let raw: string;
  try { raw = await fs.readFile(dataFile, "utf8"); } catch (err) { console.error("setPaused readFile failed:", err); return; }
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (until) data.proactivePausedUntil = until;
  else delete data.proactivePausedUntil;
  try { await fs.writeFile(dataFile, JSON.stringify(data, null, 2), "utf8"); } catch (err) { console.error("setPaused writeFile failed:", err); }
}

const HELP_TEXT = [
  "**Elias 命令列表**",
  "",
  "`/persona switch <name>` — 切换人格",
  "`/persona rename <from> <to>` — 重命名人格",
  "`/personas` — 列出所有可用人格",
  "`/clear` — 清除当前频道的对话历史",
  "`/history` — 查看当前频道最近对话",
  "`/status` — 显示 bot 运行状态",
  "`/set-master <user_id>` — 转让 Master 权限（Master only）",
  "`/set-api model <name>` — 更换模型（无需重启）",
  "`/set-api url <url>` — 更换 API URL（无需重启）",
  "`/set-api show` — 查看当前 API 设置",
  "`/userupdate` — 扫描 Obsidian 日记，更新 Elias 对主人的了解",
  "`/pause <duration>` — 暂停 proactive 主动监测（如 30m、1h、2h）",
  "`/resume` — 恢复 proactive 主动监测",
  "`/proactive <persona> on|off` — 开关某个 persona 的 proactive",
  "`/proactive list` — 查看各 persona proactive 状态",
  "`/groupchat <persona> on|off` — 开关群聊发言",
  "`/groupchat list` — 查看群聊人格列表",
  "`/todo list|add|done` — 管理目标",
  "`/setup-webhooks` — 为所有已配置的频道创建 webhook",
  "`/channel-status` — 显示当前频道的人格绑定状态",
  "`/help` — 显示此帮助信息",
].join("\n");

/**
 * Handle DM-only text command. Returns true if the message was a command
 * (already handled), false otherwise.
 */
export async function handleDMCommand(message: Message): Promise<boolean> {
  if (!message.channel.isDMBased()) return false;

  const cmd = message.content.trim();

  // /clear
  if (cmd === "/clear") {
    const historyFile = tempHistoryPath(message.channel);
    await clearHistory(historyFile);
    await sendReply(message.channel, "历史记录已清除。");
    try { await appendDailyLogRaw(`[${timeString()}] system: 历史记录已清除。\n\n`); } catch {}
    return true;
  }

  // /persona <name>
  const personaMatch = cmd.match(/^\/persona\s+(.+)$/);
  if (personaMatch) {
    const result = await switchPersona(personaMatch[1]!.trim());
    await sendReply(message.channel, result);
    try { await appendDailyLogRaw(`[${timeString()}] system: ${result}\n\n`); } catch {}
    return true;
  }

  // /pause <duration>
  const pauseMatch = cmd.match(/^\/pause\s+(.+)$/);
  if (pauseMatch) {
    const ms = parseDuration(pauseMatch[1]!);
    if (ms === 0) {
      await sendReply(message.channel, `无法解析时长：${pauseMatch[1]}。请使用如 30m、1h、2h。`);
      return true;
    }
    const until = new Date(Date.now() + ms).toISOString();
    await setPaused(until);
    const untilLocal = new Date(until).toLocaleTimeString("zh-CN", { timeZone: "Australia/Sydney" });
    await sendReply(message.channel, `Proactive 已暂停至 ${untilLocal}。`);
    return true;
  }

  // /resume
  if (cmd === "/resume") {
    await setPaused(null);
    await sendReply(message.channel, "Proactive 已恢复。");
    return true;
  }

  // /proactive list
  if (cmd === "/proactive list") {
    const disabled = await getProactiveDisabledPersonas();
    const all = await listPersonas();
    const lines = all.map((name) => {
      const state = disabled.includes(name) ? "❌ 关闭" : "✅ 开启";
      return `${name}: ${state}`;
    });
    await sendReply(message.channel, "### Proactive 状态\n" + lines.join("\n"));
    return true;
  }

  // /proactive <persona> <on|off>
  const proactiveMatch = cmd.match(/^\/proactive\s+(\S+)\s+(on|off)$/);
  if (proactiveMatch) {
    const p = proactiveMatch[1]!.toLowerCase();
    const action = proactiveMatch[2]!;
    await setPersonaProactiveDisabled(p, action === "off");
    await sendReply(message.channel, `${p} 的 proactive 已${action === "on" ? "开启" : "关闭"}。`);
    return true;
  }

  // /userupdate
  if (cmd === "/userupdate") {
    const result = await runUserUpdate();
    await sendReply(message.channel, result);
    try { await appendDailyLogRaw(`[${timeString()}] system: ${result}\n\n`); } catch {}
    return true;
  }

  // /todo list
  if (cmd === "/todo list" || cmd === "/todo") {
    const result = await manageGoals({ action: "list" });
    await sendReply(message.channel, result.content || "目前没有活跃目标。");
    return true;
  }

  // /todo done <id>
  const todoDoneMatch = cmd.match(/^\/todo\s+done\s+(.+)$/);
  if (todoDoneMatch) {
    const result = await manageGoals({ action: "done", id: todoDoneMatch[1]!.trim() });
    await sendReply(message.channel, result.content);
    return true;
  }

  // /todo add <description> [--due <time>]
  const todoAddMatch = cmd.match(/^\/todo\s+add\s+(.+)$/);
  if (todoAddMatch) {
    const rest = todoAddMatch[1]!.trim();
    const dueMatch = rest.match(/^(.*?)\s+--due\s+(.+)$/);
    const desc = dueMatch ? dueMatch[1]!.trim() : rest;
    const due = dueMatch ? dueMatch[2]!.trim() : undefined;
    const result = await manageGoals({ action: "add", description: desc, ...(due ? { due } : {}) });
    await sendReply(message.channel, result.content);
    return true;
  }

  // /groupchat list
  if (cmd === "/groupchat list") {
    const { loadChannels } = await import("./channelRegistry.js");
    const cfg = await loadChannels();
    const members = cfg.groupChat.personas;
    const allPersonas = Object.keys(cfg.personas);
    const lines = allPersonas.map((name) => {
      const inGroup = members.includes(name) ? "✅" : "❌";
      return `${name}: ${inGroup}`;
    });
    await sendReply(message.channel, "### 群聊人格\n" + lines.join("\n"));
    return true;
  }

  // /groupchat <persona> <on|off>
  const gcmatch = cmd.match(/^\/groupchat\s+(\S+)\s+(on|off)$/);
  if (gcmatch) {
    const p = gcmatch[1]!.toLowerCase();
    const action = gcmatch[2]!;
    const { loadChannels, saveChannels } = await import("./channelRegistry.js");
    const cfg = await loadChannels();
    if (action === "on" && !cfg.groupChat.personas.includes(p)) {
      cfg.groupChat.personas.push(p);
      await saveChannels(cfg);
      await sendReply(message.channel, `${p} 已加入群聊。`);
    } else if (action === "off" && cfg.groupChat.personas.includes(p)) {
      cfg.groupChat.personas = cfg.groupChat.personas.filter((n) => n !== p);
      await saveChannels(cfg);
      await sendReply(message.channel, `${p} 已退出群聊。`);
    } else {
      await sendReply(message.channel, `${p} 已经${action === "on" ? "在" : "不在"}群聊中。`);
    }
    return true;
  }

  // /personas
  if (cmd === "/personas") {
    const personas = await listPersonas();
    const lines = await Promise.all(personas.map(async (name) => {
      const triggers = await getPersonaTriggers(name);
      const triggerStr = triggers.join(" / ");
      return `**${name}** — 激活名: \`${triggerStr}\``;
    }));
    await sendReply(message.channel, "### 可用人格\n" + lines.join("\n"));
    return true;
  }

  // /set-master <user_id>
  const setMasterMatch = cmd.match(/^\/set-master\s+(\d{17,20})$/);
  if (setMasterMatch) {
    const masterId = await getMasterId();
    if (!masterId) {
      await sendReply(message.channel, "当前没有已设置的 Master。");
      return true;
    }
    if (message.author.id !== masterId) {
      await sendReply(message.channel, "权限不足。只有当前 Master 可以转让权限。");
      return true;
    }
    const { transferMaster } = await import("./auth.js");
    const result = await transferMaster(setMasterMatch[1]!);
    if (result.ok) {
      await sendReply(message.channel, `Master 权限已转让给 <@${setMasterMatch[1]}>。你已失去 Master 权限。`);
    } else {
      await sendReply(message.channel, `转让失败：${result.error}`);
    }
    return true;
  }

  // /set-api — master only
  if (cmd.startsWith("/set-api")) {
    const masterId = await getMasterId();
    if (masterId && message.author.id !== masterId) {
      await sendReply(message.channel, "权限不足。只有 Master 可以修改 API 设置。");
      return true;
    }
  }

  // /set-api model <name>
  const setApiModelMatch = cmd.match(/^\/set-api\s+model\s+(.+)$/);
  if (setApiModelMatch) {
    const dataFile = path.join(PATHS.base, "data.json");
    let data: Record<string, unknown> = {};
    try { const raw = await fs.readFile(dataFile, "utf8"); data = JSON.parse(raw) as Record<string, unknown>; } catch {}
    data.deepseekModel = setApiModelMatch[1]!.trim();
    try { await fs.writeFile(dataFile, JSON.stringify(data, null, 2), "utf8"); } catch (err) { console.error("set-api model writeFile failed:", err); }
    await sendReply(message.channel, `模型已更换为 \`${setApiModelMatch[1]!.trim()}\`。下次调用生效。`);
    return true;
  }

  // /set-api key <key>
  const setApiKeyMatch = cmd.match(/^\/set-api\s+key\s+(.+)$/);
  if (setApiKeyMatch) {
    const dataFile = path.join(PATHS.base, "data.json");
    let data: Record<string, unknown> = {};
    try { const raw = await fs.readFile(dataFile, "utf8"); data = JSON.parse(raw) as Record<string, unknown>; } catch {}
    const key = setApiKeyMatch[1]!.trim();
    data.deepseekKey = key;
    try { await fs.writeFile(dataFile, JSON.stringify(data, null, 2), "utf8"); } catch (err) { console.error("set-api key writeFile failed:", err); }
    const masked = key.length > 10 ? key.slice(0, 5) + "…" + key.slice(-4) : "***";
    await sendReply(message.channel, `API Key 已更换为 \`${masked}\`。下次调用生效。`);
    return true;
  }

  // /set-api url <url>
  const setApiUrlMatch = cmd.match(/^\/set-api\s+url\s+(.+)$/);
  if (setApiUrlMatch) {
    const dataFile = path.join(PATHS.base, "data.json");
    let data: Record<string, unknown> = {};
    try { const raw = await fs.readFile(dataFile, "utf8"); data = JSON.parse(raw) as Record<string, unknown>; } catch {}
    data.deepseekUrl = setApiUrlMatch[1]!.trim();
    try { await fs.writeFile(dataFile, JSON.stringify(data, null, 2), "utf8"); } catch (err) { console.error("set-api url writeFile failed:", err); }
    await sendReply(message.channel, `API URL 已更换为 \`${setApiUrlMatch[1]!.trim()}\`。下次调用生效。`);
    return true;
  }

  // /set-api show
  if (cmd === "/set-api show") {
    const { getModel, getApiUrl } = await import("../config.js");
    const currentModel = await getModel();
    const currentUrl = await getApiUrl();
    await sendReply(message.channel, `**当前 API 设置**\n模型：\`${currentModel}\`\nURL：\`${currentUrl}\``);
    return true;
  }

  // /history
  if (cmd === "/history") {
    const histFile = tempHistoryPath(message.channel);
    const { getHistory } = await import("./history.js");
    const messages = await getHistory(histFile);
    if (messages.length === 0) {
      await sendReply(message.channel, "当前频道没有对话历史。");
    } else {
      const lines = messages.slice(-10).map((m, i) => {
        const role = m.role === "user" ? "👤" : "🤖";
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        const preview = text.slice(0, 200).replace(/\n/g, " ");
        return `${role} **#${messages.length - 10 + i + 1}** ${preview}${text.length > 200 ? "…" : ""}`;
      });
      await sendReply(message.channel, "### 对话历史（最近 10 条）\n" + lines.join("\n"));
    }
    return true;
  }

  // /status
  if (cmd === "/status") {
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const personas = await listPersonas();
    const disabled = await getProactiveDisabledPersonas();
    const data = await (async () => {
      try {
        const raw = await fs.readFile(path.join(PATHS.base, "data.json"), "utf8");
        return JSON.parse(raw) as Record<string, unknown>;
      } catch { return {}; }
    })();
    const paused = data.proactivePausedUntil
      ? new Date(data.proactivePausedUntil as string).getTime() > Date.now()
      : false;

    let kbOk = false;
    try {
      await fs.access(PATHS.knowledgeBase);
      const s = await fs.stat(PATHS.knowledgeBase);
      kbOk = s.isDirectory();
    } catch { /* no */ }

    const { getModel } = await import("../config.js");
    const currentModel = await getModel();
    const masterId = await getMasterId();
    const lines = [
      `⏱ **运行时间** ${h}h ${m}m`,
      `👑 **Master** ${masterId ? `<@${masterId}>` : "未设置"}`,
      `🧠 **模型** ${currentModel}`,
      `👥 **人格数** ${personas.length}（${personas.join(", ")}）`,
      `📂 **Knowledge Base** ${kbOk ? "✅ 已连接" : "❌ 不可用"}`,
      `📡 **Proactive** ${paused ? "⏸ 已暂停" : "✅ 运行中"}`,
    ];
    if (disabled.length > 0) {
      lines.push(`🚫 **关闭的 Proactive** ${disabled.join(", ")}`);
    }
    await sendReply(message.channel, "### Elias 运行状态\n" + lines.join("\n"));
    return true;
  }

  // /help
  if (cmd === "/help") {
    await sendReply(message.channel, HELP_TEXT);
    return true;
  }

  return false;
}
