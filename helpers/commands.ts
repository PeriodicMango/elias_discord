import fs from "node:fs/promises";
import path from "node:path";
import { REST, Routes, type Client, type Interaction } from "discord.js";
import { DISCORD_TOKEN, PATHS } from "../config.js";
import { clearHistory, tempHistoryPath } from "./history.js";
import { manageGoals } from "./tools/executors/goals.js";
import { runUserUpdate } from "./userUpdate.js";
import { getProactiveDisabledPersonas, setPersonaProactiveDisabled } from "./proactive.js";
import { listPersonas, getPersonaTriggers, clearPersonaCache } from "./personas.js";
import { getMasterId } from "./auth.js";

export async function switchPersona(name: string): Promise<string> {
  const available = await listPersonas();
  if (!available.includes(name)) {
    return `没有这个人格。可用：${available.join(", ")}`;
  }
  const dataFile = path.join(PATHS.base, "data.json");
  let raw: string;
  try { raw = await fs.readFile(dataFile, "utf8"); } catch (err) { console.error("switchPersona readFile failed:", err); return "读取数据文件失败。"; }
  const data = JSON.parse(raw) as Record<string, unknown>;
  const outgoing = (data.activePersona as string) ?? "elias";

  // Process transition only if actually switching to a different persona
  let note = "";
  if (name !== outgoing) {
    const { processPersonaTransition } = await import("./personaTransition.js");
    note = await processPersonaTransition(name);
  }

  // Update timestamps and switch (dmPersona replaces activePersona)
  const timestamps = (data.personaTimestamps as Record<string, string>) ?? {};
  timestamps[outgoing] = new Date().toISOString();
  data.personaTimestamps = timestamps;
  data.dmPersona = name;
  // Keep activePersona for backward compat
  data.activePersona = name;
  try { await fs.writeFile(dataFile, JSON.stringify(data, null, 2), "utf8"); } catch (err) { console.error("switchPersona writeFile failed:", err); }

  let msg = `人格已切换为：${name}（DM 默认人格）`;
  if (note) msg += `\n${name} 醒来后注意到：${note}`;

  // Clear caches
  const { clearCaches } = await import("../prompt.js");
  clearCaches();

  return msg;
}

export async function renamePersona(from: string, to: string): Promise<string> {
  const available = await listPersonas();
  if (!available.includes(from)) {
    return `人格 "${from}" 不存在。可用：${available.join(", ")}`;
  }
  if (available.includes(to)) {
    return `人格 "${to}" 已存在。`;
  }
  if (!/^[a-z0-9_-]+$/i.test(to)) {
    return "人格名称只能包含字母、数字、下划线和连字符。";
  }

  // 1. Rename persona file
  const fromFile = path.join(PATHS.base, "personas", `${from}.md`);
  const toFile = path.join(PATHS.base, "personas", `${to}.md`);
  await fs.rename(fromFile, toFile);

  // 2. Rename data directories (history, daily_log, daily_summary, etc.)
  const fromDataDir = path.join(PATHS.base, "knowledge_base", "Elias", from);
  const toDataDir = path.join(PATHS.base, "knowledge_base", "Elias", to);
  try { await fs.rename(fromDataDir, toDataDir); } catch { /* ok if missing */ }

  // 3. Update data.json if activePersona or dmPersona points to old name
  const dataFile = path.join(PATHS.base, "data.json");
  try {
    const raw = await fs.readFile(dataFile, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    let changed = false;
    if (data.activePersona === from) { data.activePersona = to; changed = true; }
    if (data.dmPersona === from) { data.dmPersona = to; changed = true; }
    if (changed) await fs.writeFile(dataFile, JSON.stringify(data, null, 2), "utf8");
  } catch { /* ok */ }

  // 4. Update channels.json if old persona is configured
  try {
    const channelsFile = path.join(PATHS.base, "config", "channels.json");
    const raw = await fs.readFile(channelsFile, "utf8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    let changed = false;
    const personas = cfg.personas as Record<string, unknown> | undefined;
    if (personas && personas[from]) {
      personas[to] = personas[from]!;
      delete personas[from];
      changed = true;
    }
    const gc = cfg.groupChat as { personas?: string[] } | undefined;
    if (gc?.personas) {
      const idx = gc.personas.indexOf(from);
      if (idx !== -1) { gc.personas[idx] = to; changed = true; }
    }
    if (cfg.dmDefaultPersona === from) { cfg.dmDefaultPersona = to; changed = true; }
    if (changed) await fs.writeFile(channelsFile, JSON.stringify(cfg, null, 2), "utf8");
  } catch { /* channels.json may not exist */ }

  // 5. Clear caches
  const { clearCaches } = await import("../prompt.js");
  clearCaches();
  clearPersonaCache();

  return `人格已重命名：${from} → ${to}`;
}

export function parseDuration(s: string): number {
  const m = s.trim().match(/^(\d+)\s*(m|min|分钟|h|小时)$/i);
  if (!m) return 0;
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  if (unit === "h" || unit === "小时") return n * 60 * 60 * 1000;
  return n * 60 * 1000; // m / min / 分钟
}

const SLASH_COMMANDS = [
  {
    name: "clear",
    description: "清除 Elias 在当前频道的对话历史",
  },
  {
    name: "userupdate",
    description: "扫描 Obsidian 日记，更新 Elias 对主人的了解",
  },
  {
    name: "persona",
    description: "管理人格（切换 / 重命名）",
    options: [
      {
        name: "switch",
        description: "切换人格",
        type: 1, // SUB_COMMAND
        options: [
          { name: "name", description: "人格名称", type: 3, required: true },
        ],
      },
      {
        name: "rename",
        description: "重命名人格",
        type: 1,
        options: [
          { name: "from", description: "当前名称", type: 3, required: true },
          { name: "to", description: "新名称", type: 3, required: true },
        ],
      },
    ],
  },
  {
    name: "pause",
    description: "暂停 proactive 主动监测",
    options: [
      {
        name: "duration",
        description: "暂停时长，如 30m、1h、2h",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "resume",
    description: "恢复 proactive 主动监测",
  },
  {
    name: "proactive",
    description: "开关某个 persona 的 proactive 监测",
    options: [
      { name: "persona", description: "人格名称（wanshi/elias/raw）或 list", type: 3, required: true },
      { name: "action", description: "on / off（查看用 list 则不需要）", type: 3, required: false },
    ],
  },
  {
    name: "set-master",
    description: "转让 Master 权限给另一个用户",
    options: [
      {
        name: "user_id",
        description: "新 Master 的 Discord 用户 ID",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "set-api",
    description: "更换 DeepSeek API 模型或 URL（无需重启）",
    options: [
      {
        name: "model",
        description: "更换模型",
        type: 1,
        options: [
          { name: "name", description: "模型名，如 deepseek-v4-pro", type: 3, required: true },
        ],
      },
      {
        name: "url",
        description: "更换 API URL",
        type: 1,
        options: [
          { name: "url", description: "Anthropic-format API URL", type: 3, required: true },
        ],
      },
      {
        name: "key",
        description: "更换 API Key",
        type: 1,
        options: [
          { name: "key", description: "DeepSeek API Key (sk-...)", type: 3, required: true },
        ],
      },
      {
        name: "show",
        description: "显示当前 API 设置",
        type: 1,
      },
    ],
  },
  {
    name: "history",
    description: "查看当前频道的对话历史摘要",
  },
  {
    name: "status",
    description: "显示 bot 运行状态（运行时间、模型、人格数等）",
  },
  {
    name: "help",
    description: "显示所有可用命令",
  },
  {
    name: "personas",
    description: "列出所有可用人格及其激活名称",
  },
  {
    name: "groupchat",
    description: "开关群聊中某个人格的发言权限",
    options: [
      { name: "persona", description: "人格名称（wanshi/elias/raw）或 list", type: 3, required: true },
      { name: "action", description: "on / off（查看用 list 则不需要）", type: 3, required: false },
    ],
  },
  {
    name: "todo",
    description: "管理目标",
    options: [
      {
        name: "list",
        description: "列出所有活跃目标",
        type: 1, // SUB_COMMAND
      },
      {
        name: "add",
        description: "添加新目标",
        type: 1,
        options: [
          { name: "description", description: "目标描述", type: 3, required: true },
          { name: "due", description: "截止时间（如'今晚''明天3pm'）", type: 3, required: false },
        ],
      },
      {
        name: "done",
        description: "标记目标为已完成",
        type: 1,
        options: [
          { name: "id", description: "目标 ID（用 /todo list 查看）", type: 3, required: true },
        ],
      },
    ],
  },
  {
    name: "setup-webhooks",
    description: "为所有已配置的频道创建 webhook（需要 MANAGE_WEBHOOKS 权限）",
  },
  {
    name: "channel-status",
    description: "显示当前频道的人格绑定状态",
  },
];

const HELP_TEXT = [
  "**Elias 命令列表**",
  "",
  "`/persona switch <name>` — 切换人格",
  "`/persona rename <from> <to>` — 重命名人格",
  "`/personas` — 列出所有可用人格及激活名称",
  "`/clear` — 清除当前频道的对话历史（DM 也支持）",
  "`/history` — 查看当前频道最近对话摘要",
  "`/status` — 显示 bot 运行状态",
  "`/set-master <user_id>` — 转让 Master 权限（Master only）",
  "`/set-api model <name>` — 更换模型（无需重启）",
  "`/set-api url <url>` — 更换 API URL（无需重启）",
  "`/set-api key <key>` — 更换 API Key（无需重启）",
  "`/set-api show` — 查看当前 API 设置",
  "`/userupdate` — 扫描 Obsidian 日记，更新 Elias 对主人的了解",
  "`/pause <duration>` — 暂停 proactive 主动监测（如 30m、1h、2h）",
  "`/resume` — 恢复 proactive 主动监测",
  "`/proactive <persona> on|off` — 开关某个 persona 的 proactive",
  "`/proactive list` — 查看各 persona proactive 状态",
  "`/todo list` — 查看当前所有活跃目标",
  "`/todo add <描述> [截止]` — 手动添加目标",
  "`/todo done <id>` — 标记目标完成",
  "`/groupchat <persona> on|off` — 开关群聊中某个人格的发言",
  "`/groupchat list` — 查看群聊人格列表",
  "`/setup-webhooks` — 为所有已配置的频道创建 webhook",
  "`/channel-status` — 显示当前频道的人格绑定状态",
  "`/help` — 显示此帮助信息",
  "",
  "DM 中同样可用，直接输入 `/命令名` 即可。",
].join("\n");

export async function registerSlashCommands(client: Client): Promise<void> {
  try {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    const appId = client.user!.id;

    // Register per-guild for instant sync. PUT overwrites existing commands
    // atomically — no purge step needed.
    const guilds = [...client.guilds.cache.values()];
    for (const guild of guilds) {
      await rest.put(Routes.applicationGuildCommands(appId, guild.id), {
        body: SLASH_COMMANDS,
      });
    }
    console.log(`Slash commands registered in ${guilds.length} guild(s).`);
  } catch (err) {
    console.error(`Slash command registration failed: ${err}`);
  }
}

export async function handleInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  switch (interaction.commandName) {
    case "clear": {
      const historyFile = tempHistoryPath(interaction.channel!);
      await clearHistory(historyFile);
      await interaction.reply({ content: "历史记录已清除。", ephemeral: true });
      break;
    }
    case "userupdate": {
      await interaction.deferReply({ ephemeral: true });
      const result = await runUserUpdate();
      await interaction.editReply(result);
      break;
    }
    case "persona": {
      await interaction.deferReply({ ephemeral: true });
      const sub = interaction.options.getSubcommand();
      if (sub === "switch") {
        const name = interaction.options.getString("name", true);
        const result = await switchPersona(name);
        await interaction.editReply(result);
      } else if (sub === "rename") {
        const from = interaction.options.getString("from", true);
        const to = interaction.options.getString("to", true);
        const result = await renamePersona(from, to);
        await interaction.editReply(result);
      }
      break;
    }
    case "pause": {
      const dur = interaction.options.getString("duration", true);
      const ms = parseDuration(dur);
      if (ms === 0) {
        await interaction.reply({ content: `无法解析时长：${dur}。请使用如 30m、1h、2h 的格式。`, ephemeral: true });
        break;
      }
      const until = new Date(Date.now() + ms).toISOString();
      const dataFile = path.join(PATHS.base, "data.json");
      let raw: string;
      try { raw = await fs.readFile(dataFile, "utf8"); } catch (err) { console.error("pause readFile failed:", err); await interaction.reply({ content: "暂停失败，无法读取数据文件。", ephemeral: true }); break; }
      const data = JSON.parse(raw) as Record<string, unknown>;
      data.proactivePausedUntil = until;
      try { await fs.writeFile(dataFile, JSON.stringify(data, null, 2), "utf8"); } catch (err) { console.error("pause writeFile failed:", err); }
      await interaction.reply({ content: `Proactive 已暂停至 ${new Date(until).toLocaleTimeString("zh-CN", { timeZone: "Australia/Sydney" })}。`, ephemeral: true });
      break;
    }
    case "resume": {
      const dataFile = path.join(PATHS.base, "data.json");
      let raw: string;
      try { raw = await fs.readFile(dataFile, "utf8"); } catch (err) { console.error("resume readFile failed:", err); await interaction.reply({ content: "恢复失败，无法读取数据文件。", ephemeral: true }); break; }
      const data = JSON.parse(raw) as Record<string, unknown>;
      delete data.proactivePausedUntil;
      try { await fs.writeFile(dataFile, JSON.stringify(data, null, 2), "utf8"); } catch (err) { console.error("resume writeFile failed:", err); }
      await interaction.reply({ content: "Proactive 已恢复。", ephemeral: true });
      break;
    }
    case "proactive": {
      await interaction.deferReply({ ephemeral: true });
      const p = interaction.options.getString("persona", true).toLowerCase();
      if (p === "list") {
        const disabled = await getProactiveDisabledPersonas();
        const all = await listPersonas();
        const lines = all.map((name) => {
          const state = disabled.includes(name) ? "❌ 关闭" : "✅ 开启";
          return `${name}: ${state}`;
        });
        await interaction.editReply("### Proactive 状态\n" + lines.join("\n"));
        break;
      }
      const action = (interaction.options.getString("action") ?? "").toLowerCase();
      if (action === "on") {
        await setPersonaProactiveDisabled(p, false);
        await interaction.editReply(`${p} 的 proactive 已开启。`);
      } else if (action === "off") {
        await setPersonaProactiveDisabled(p, true);
        await interaction.editReply(`${p} 的 proactive 已关闭。`);
      } else {
        await interaction.editReply(`用法: /proactive <persona> on|off 或 /proactive list`);
      }
      break;
    }
    case "personas": {
      await interaction.deferReply({ ephemeral: true });
      const files = await listPersonas();
      const lines = await Promise.all(files.map(async (name) => {
        const triggers = await getPersonaTriggers(name);
        const triggerStr = triggers.join(" / ");
        return `**${name}** — 激活名: \`${triggerStr}\``;
      }));
      await interaction.editReply("### 可用人格\n" + lines.join("\n"));
      break;
    }
    case "groupchat": {
      await interaction.deferReply({ ephemeral: true });
      const p = interaction.options.getString("persona", true).toLowerCase();
      const { loadChannels, saveChannels } = await import("./channelRegistry.js");
      const cfg = await loadChannels();
      if (p === "list") {
        const members = cfg.groupChat.personas;
        const allPersonas = Object.keys(cfg.personas);
        const lines = allPersonas.map((name) => {
          const inGroup = members.includes(name) ? "✅" : "❌";
          return `${name}: ${inGroup}`;
        });
        await interaction.editReply("### 群聊人格\n" + lines.join("\n"));
        break;
      }
      const action = (interaction.options.getString("action") ?? "").toLowerCase();
      if (!cfg.groupChat.personas.includes(p) && action === "on") {
        cfg.groupChat.personas.push(p);
        await saveChannels(cfg);
        await interaction.editReply(`${p} 已加入群聊。`);
      } else if (cfg.groupChat.personas.includes(p) && action === "off") {
        cfg.groupChat.personas = cfg.groupChat.personas.filter((n) => n !== p);
        await saveChannels(cfg);
        await interaction.editReply(`${p} 已退出群聊。`);
      } else if (action === "on" || action === "off") {
        await interaction.editReply(`${p} 已经${action === "on" ? "在" : "不在"}群聊中。`);
      } else {
        await interaction.editReply("用法: /groupchat <persona> on|off 或 /groupchat list");
      }
      break;
    }
    case "set-master": {
      await interaction.deferReply({ ephemeral: true });
      const masterId = await getMasterId();
      if (!masterId) {
        await interaction.editReply("当前没有已设置的 Master。");
        break;
      }
      if (interaction.user.id !== masterId) {
        await interaction.editReply("权限不足。只有当前 Master 可以转让权限。");
        break;
      }
      const newId = interaction.options.getString("user_id", true);
      const { transferMaster } = await import("./auth.js");
      const result = await transferMaster(newId);
      if (result.ok) {
        await interaction.editReply(`Master 权限已转让给 <@${newId}>。你已失去 Master 权限。`);
      } else {
        await interaction.editReply(`转让失败：${result.error}`);
      }
      break;
    }
    case "set-api": {
      await interaction.deferReply({ ephemeral: true });
      // Master-only: API credentials are sensitive
      const masterId = await getMasterId();
      if (masterId && interaction.user.id !== masterId) {
        await interaction.editReply("权限不足。只有 Master 可以修改 API 设置。");
        break;
      }
      const sub = interaction.options.getSubcommand();
      const dataFile = path.join(PATHS.base, "data.json");
      let data: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(dataFile, "utf8");
        data = JSON.parse(raw) as Record<string, unknown>;
      } catch { /* will create */ }

      if (sub === "model") {
        const model = interaction.options.getString("name", true);
        data.deepseekModel = model;
        try { await fs.writeFile(dataFile, JSON.stringify(data, null, 2), "utf8"); } catch (err) { console.error("set-api model writeFile failed:", err); }
        await interaction.editReply(`模型已更换为 \`${model}\`。下次调用生效。`);
      } else if (sub === "url") {
        const url = interaction.options.getString("url", true);
        data.deepseekUrl = url;
        try { await fs.writeFile(dataFile, JSON.stringify(data, null, 2), "utf8"); } catch (err) { console.error("set-api url writeFile failed:", err); }
        await interaction.editReply(`API URL 已更换为 \`${url}\`。下次调用生效。`);
      } else if (sub === "key") {
        const key = interaction.options.getString("key", true);
        data.deepseekKey = key;
        try { await fs.writeFile(dataFile, JSON.stringify(data, null, 2), "utf8"); } catch (err) { console.error("set-api key writeFile failed:", err); }
        const masked = key.length > 10 ? key.slice(0, 5) + "…" + key.slice(-4) : "***";
        await interaction.editReply(`API Key 已更换为 \`${masked}\`。下次调用生效。`);
      } else if (sub === "show") {
        const { getModel, getApiUrl } = await import("../config.js");
        const currentModel = await getModel();
        const currentUrl = await getApiUrl();
        await interaction.editReply(
          `**当前 API 设置**\n模型：\`${currentModel}\`\nURL：\`${currentUrl}\``,
        );
      }
      break;
    }
    case "history": {
      await interaction.deferReply({ ephemeral: true });
      try {
        const histFile = tempHistoryPath(interaction.channel!);
        const { getHistory } = await import("./history.js");
        const messages = await getHistory(histFile);
        if (messages.length === 0) {
          await interaction.editReply("当前频道没有对话历史。");
        } else {
          const lines = messages.slice(-10).map((m, i) => {
            const role = m.role === "user" ? "👤" : "🤖";
            const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            const preview = text.slice(0, 200).replace(/\n/g, " ");
            return `${role} **#${messages.length - 10 + i + 1}** ${preview}${text.length > 200 ? "…" : ""}`;
          });
          await interaction.editReply(`### 对话历史（最近 ${Math.min(10, messages.length)} 条）\n${lines.join("\n")}`);
        }
      } catch (err) {
        console.error("history failed:", err); await interaction.editReply("读取历史失败。");
      }
      break;
    }
    case "status": {
      await interaction.deferReply({ ephemeral: true });
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
      await interaction.editReply("### Elias 运行状态\n" + lines.join("\n"));
      break;
    }
    case "help": {
      await interaction.reply({ content: HELP_TEXT, ephemeral: true });
      break;
    }
    case "todo": {
      await interaction.deferReply({ ephemeral: true });
      const sub = interaction.options.getSubcommand();
      let result;
      if (sub === "list") {
        result = await manageGoals({ action: "list" });
      } else if (sub === "add") {
        const desc = interaction.options.getString("description", true);
        const due = interaction.options.getString("due") ?? undefined;
        result = await manageGoals({ action: "add", description: desc, due });
      } else if (sub === "done") {
        const id = interaction.options.getString("id", true);
        result = await manageGoals({ action: "done", id });
      } else {
        result = { content: `未知子命令: ${sub}` };
      }
      await interaction.editReply(result.content || "完成。");
      break;
    }
    case "setup-webhooks": {
      await interaction.deferReply({ ephemeral: true });
      const { createWebhooksForChannel } = await import("./webhookManager.js");
      const { loadChannels } = await import("./channelRegistry.js");
      const cfg = await loadChannels();

      const results: string[] = [];

      // Persona channels
      for (const [persona, pcfg] of Object.entries(cfg.personas)) {
        if (!pcfg.channelId || !pcfg.enabled) continue;
        const res = await createWebhooksForChannel(
          interaction.client,
          pcfg.channelId,
          [persona],
        );
        for (const r of res) {
          results.push(`${r.persona}: ${r.ok ? "✅" : "❌ " + r.error}`);
        }
      }

      // Group chat
      if (cfg.groupChat.enabled && cfg.groupChat.channelId) {
        const res = await createWebhooksForChannel(
          interaction.client,
          cfg.groupChat.channelId,
          cfg.groupChat.personas,
        );
        for (const r of res) {
          results.push(`群聊/${r.persona}: ${r.ok ? "✅" : "❌ " + r.error}`);
        }
      }

      await interaction.editReply(
        results.length > 0
          ? "Webhook 创建结果：\n" + results.join("\n")
          : "没有需要创建 webhook 的频道。请先设置 channels.json。",
      );
      break;
    }
    case "channel-status": {
      await interaction.deferReply({ ephemeral: true });
      const { getPersonaForChannel, isGroupChatChannel } = await import("./channelRegistry.js");
      const channelId = interaction.channel!.id;
      const isGroup = await isGroupChatChannel(channelId);
      const persona = await getPersonaForChannel(channelId);

      let msg = `当前频道 ID: ${channelId}\n`;
      if (isGroup) {
        msg += "类型：群聊频道";
      } else if (persona) {
        msg += `绑定人格：${persona}`;
      } else {
        msg += "类型：未绑定（使用默认人格或 data.json fallback）";
      }
      await interaction.editReply(msg);
      break;
    }
  }
}
