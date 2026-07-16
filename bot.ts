import {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
  type Message,
} from "discord.js";
import { VISION_ENABLED } from "./config.js";
import { getMasterId, getMasterTag, setMasterId } from "./helpers/auth.js";
import { assemblePrompt, loadDynamicRules, loadPersonaNotebook, loadSoul, loadUserProfile, readActivePersona } from "./prompt.js";
import { appendDailyLogRaw, getRecentMemory, getSemanticKnowledge, getUserContext, timeString } from "./memory.js";
import { chatDualPipeline } from "./llm.js";
import { classifySender, ensureComplete, masterTitle, rewriteMentions, sendReply, shouldRespond } from "./helpers/discord.js";
import { appendHistory, getHistory, pushHistoryMessage, tempHistoryPath } from "./helpers/history.js";
import { handleInteraction, registerSlashCommands } from "./helpers/commands.js";
import { handleDMCommand } from "./helpers/commandsDM.js";
import { getAllToolDefinitions } from "./helpers/tools.js";
import { processAttachments } from "./helpers/attachments.js";
import { onUserMessage, getStatusPrompt, getCurrentStatus, setStatus, SLEEP_PREPARE_PROMPT, isSleepTrigger, isSleepHours } from "./helpers/status.js";
import { getPersonaForChannel, isGroupChatChannel, getDmPersona, getGroupChatPersonas, getPersonaConfig } from "./helpers/channelRegistry.js";
import { sendAsPersona } from "./helpers/webhookManager.js";
import { buildStatusEmbed } from "./helpers/embedBuilder.js";
import { parseMoodTag } from "./helpers/moodParser.js";
import { personaPath } from "./config.js";
import { getPersonaTriggers } from "./helpers/personas.js";
import type { ChatMessage } from "./llm.js";

// ---------------------------------------------------------------------------
// Resolve which persona handles this message
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Single-persona message handler
// ---------------------------------------------------------------------------

async function handlePersonaMessage(
  persona: string,
  message: Message,
  client: Client,
): Promise<void> {
  if (!client.user) return;

  await ensureComplete(message);

  if (message.author.id === client.user.id) return;
  if (message.author.bot) return;

  const rawContent = message.content;
  const isDM = message.channel.isDMBased();

  // Auto-master: first DM to the bot claims master (locked forever)
  if (isDM && !(await getMasterId())) {
    await setMasterId(message.author.id);
    console.log(`[SYSTEM LOG] First DM detected — master locked as: ${message.author.id}`);
  }

  const masterId = await getMasterId();
  const hasTag = (await getMasterTag()) && rawContent.includes((await getMasterTag()));
  const isMasterId = message.author.id === masterId;

  const classification = await classifySender(message.author.id, message.author.username);
  const level: "master" | "friend" | "stranger" = hasTag
    ? "master"
    : (isDM && isMasterId)
      ? "master"
      : classification.level;

  const senderName = level === "master"
    ? "漓琊 (Master)"
    : classification.sender;

  const cleanContent = hasTag ? rawContent.replace((await getMasterTag()), "").trim() : rawContent;
  const rewritten = isDM ? cleanContent : await rewriteMentions(cleanContent, client.user.id, persona);
  const formatted = `${senderName}: ${rewritten}`;

  // Daily log
  try { await appendDailyLogRaw(`[${timeString()}] ${formatted}\n`, persona); } catch (err) { console.error(`Daily log error: ${err}`); }

  if (!(await shouldRespond(message, client.user.id, persona))) return;

  const attachmentResult = await processAttachments(message);
  console.log(`${senderName}: ${attachmentResult.note}${rewritten}`);

  if (await handleDMCommand(message)) return;
  const historyFile = tempHistoryPath(message.channel, persona);

  // Assemble system prompts
  const title = await masterTitle(persona);
  const [soul, replyPrompt, thinkingPrompt, dynamicRules, userProfile, personaNotes] = await Promise.all([
    loadSoul(persona),
    assemblePrompt({
      persona,
      senderLevel: level,
      mode: "chat-reply",
      variables: { PERSONA_TITLE: title, MASTER_NAME: "漓琊" },
    }),
    assemblePrompt({
      persona,
      senderLevel: level,
      mode: "chat-thinking",
      variables: { PERSONA_TITLE: title, MASTER_NAME: "漓琊" },
    }),
    loadDynamicRules(),
    loadUserProfile(),
    loadPersonaNotebook(persona),
  ]);
  const [userContext, recentMemory, retrievedKnowledge] = await Promise.all([
    getUserContext(formatted), getRecentMemory(persona), getSemanticKnowledge(formatted),
  ]);
  const currentTime = new Date().toLocaleString("zh-CN", { timeZone: "Australia/Sydney", hour12: false });
  const contextSuffix = `${dynamicRules}${personaNotes}\n\n当前时间：${currentTime}\n\n### User Profile ###\n${userProfile}${userContext}${retrievedKnowledge}\n\n${recentMemory}`;
  const thinkingSystem = `${soul}\n\n${thinkingPrompt}${contextSuffix}`;
  const replySystem = `${soul}\n\n${replyPrompt}${contextSuffix}`;

  // Status injection
  const isSleepSeq = isSleepTrigger(rewritten) && isSleepHours() && Math.random() < 0.9;
  let sleepTriggered = false;

  let statusInject: string;
  if (isSleepSeq) {
    sleepTriggered = true;
    const currentPrompt = await getStatusPrompt(persona);
    statusInject = [currentPrompt, SLEEP_PREPARE_PROMPT].filter(Boolean).join("\n\n");
  } else {
    const [statusPrompt, wakeUpAnger] = await Promise.all([
      getStatusPrompt(persona),
      onUserMessage(level, persona),
    ]);
    statusInject = [statusPrompt, wakeUpAnger].filter(Boolean).join("\n\n");
  }

  const thinkingSystemWithStatus = statusInject
    ? `${thinkingSystem}\n\n${statusInject}`
    : thinkingSystem;
  const replySystemWithStatus = statusInject
    ? `${replySystem}\n\n${statusInject}`
    : replySystem;

  // Sync Discord presence
  const currentStatus = await getCurrentStatus(persona);
  client.user.setActivity(currentStatus.label, { type: ActivityType.Custom });

  // History
  const userContent = attachmentResult.note ? `${attachmentResult.note}${rewritten}` : rewritten;
  const history = await getHistory(historyFile);
  history.push({ role: "user", content: userContent });

  const userText = attachmentResult.note ? `${senderName}: ${attachmentResult.note}${rewritten}` : formatted;
  appendHistory(historyFile, userText).catch((err) => console.error(`History write error: ${err}`));

  if (VISION_ENABLED && attachmentResult.imageBlocks.length > 0 && history.length > 0) {
    const last = history[history.length - 1]!;
    if (last.role === "user") {
      last.content = [...attachmentResult.imageBlocks, { type: "text" as const, text: userText }];
    }
  }

  // LLM call
  let reply: string;
  let mood: string | null = null;
  let toolsUsed: string[] = [];
  try {
    const result = await chatDualPipeline(
      history,
      thinkingSystemWithStatus,
      replySystemWithStatus,
      { tools: getAllToolDefinitions(), senderLevel: level },
    );
    toolsUsed = result.toolsUsed;
    if (result.thinking) {
      try { await appendDailyLogRaw(`[${timeString()}] ${persona} thinking:\n${result.thinking}\n---\n`, persona); } catch {}
    }

    // Parse mood tag from raw text (before sanitization strips brackets)
    const moodParsed = parseMoodTag(result.text);
    mood = moodParsed.mood;

    // Existing sanitization (strip [/system] tags, persona name prefixes)
    let sanitized = moodParsed.text.replace(/\[\/?system\]/g, "").trim();
    const stripPrefixes = ["万事", "Elias", "elias", "ELIAS", "Raw", "raw"];
    for (const prefix of stripPrefixes) {
      for (const sep of [":", "："]) {
        if (sanitized.startsWith(prefix + sep)) {
          sanitized = sanitized.slice(prefix.length + sep.length).trim();
        }
      }
    }
    reply = sanitized;
  } catch (err) {
    console.error(`API Error: ${err}`);
    await sendReply(message.channel, `[Error: ${String(err)}]`);
    return;
  }

  // Log reply
  try { await appendDailyLogRaw(`[${timeString()}] ${persona}: ${reply}\n\n`, persona); } catch (err) { console.error(`Log error: ${err}`); }
  if (!reply) reply = "（遵命。）";

  pushHistoryMessage(historyFile, { role: "assistant", content: reply });
  await appendHistory(historyFile, `${persona}: ${reply}`);
  const embed = buildStatusEmbed(persona, mood, toolsUsed);
  await sendAsPersona(message.channel, persona, reply, client, embed);

  if (sleepTriggered) {
    await setStatus("half_asleep", persona);
    client.user?.setActivity("半睡半醒", { type: ActivityType.Custom });
  }
}

// ---------------------------------------------------------------------------
// Group chat: multi-persona fan-out with history isolation
// ---------------------------------------------------------------------------

/** Strip stylistic markers from a persona's message, keeping only factual content. */
function summarizePersonaMessage(text: string, persona: string): string {
  // Remove common stylistic markers
  let s = text
    .replace(/唔…|呼啊…|……/g, "")
    .replace(/（[^）]*）/g, "")       // bracket actions
    .replace(/\([^)]*\)/g, "")        // English bracket actions
    .replace(/\s+/g, " ")
    .trim();
  // Truncate to ~60 chars to keep it truly a summary
  if (s.length > 60) s = s.slice(0, 60) + "…";
  return `[${persona}]: ${s}`;
}


async function handleGroupChatMessage(
  message: Message,
  client: Client,
  level: "master" | "friend" | "stranger",
  senderName: string,
): Promise<void> {
  let personas = await getGroupChatPersonas();
  if (personas.length === 0) return;

  const rawContent = message.content;
  const hasTag = (await getMasterTag()) && rawContent.includes((await getMasterTag()));
  const cleanContent = hasTag ? rawContent.replace((await getMasterTag()), "").trim() : rawContent;
  const formatted = `${senderName}: ${cleanContent}`;

  // @-mention targeting: only trigger when the bot is actually pinged via Discord @mention.
  // Just typing a persona name without @-mention is conversation ABOUT them, not TO them.
  const botWasMentioned = message.mentions.has(client.user!.id);
  if (botWasMentioned) {
    const lower = cleanContent.toLowerCase();
    // Resolve targeted personas by checking each persona's triggers
    const targetedPersonas: string[] = [];
    for (const p of personas) {
      const triggers = await getPersonaTriggers(p);
      if (triggers.some((t) => lower.includes(t.toLowerCase()))) {
        targetedPersonas.push(p);
      }
    }

    if (targetedPersonas.length > 0) {
      personas = targetedPersonas;
      console.log(`[GROUP] @mention → ${personas.join(", ")}`);
    }
  }

  // Log user message to each participating persona's daily_log
  for (const p of personas) {
    appendDailyLogRaw(`[${timeString()}] ${formatted}\n`, p).catch(() => {});
  }

  console.log(`[GROUP] ${formatted}`);

  // Fan out to selected personas in parallel
  const results = await Promise.allSettled(
    personas.map(async (persona) => {
      // Load persona-specific history view
      const histFile = personaPath(persona, "history", `group-${message.channel.id}.md`);
      const history = await getHistory(histFile);

      // Add the new user message
      history.push({ role: "user", content: cleanContent });

      // Build prompts
      const title = await masterTitle(persona);
      const [soul, replyPrompt, thinkingPrompt, dynamicRules, userProfile, personaNotes] = await Promise.all([
        loadSoul(persona),
        assemblePrompt({
          persona,
          senderLevel: level,
          mode: "group-chat",
          variables: { PERSONA_TITLE: title, MASTER_NAME: "漓琊" },
        }),
        assemblePrompt({
          persona,
          senderLevel: level,
          mode: "chat-thinking",
          variables: { PERSONA_TITLE: title, MASTER_NAME: "漓琊" },
        }),
        loadDynamicRules(),
        loadUserProfile(),
        loadPersonaNotebook(persona),
      ]);
      const [userContext, recentMemory, retrievedKnowledge] = await Promise.all([
        getUserContext(formatted),
        getRecentMemory(persona),
        getSemanticKnowledge(formatted),
      ]);
      const currentTime = new Date().toLocaleString("zh-CN", { timeZone: "Australia/Sydney", hour12: false });
  const contextSuffix = `${dynamicRules}${personaNotes}\n\n当前时间：${currentTime}\n\n### User Profile ###\n${userProfile}${userContext}${retrievedKnowledge}\n\n${recentMemory}`;

      const statusPrompt = await getStatusPrompt(persona);
      const thinkingSystem = `${soul}\n\n${thinkingPrompt}${contextSuffix}\n\n${statusPrompt}`;
      const replySystem = `${soul}\n\n${replyPrompt}${contextSuffix}\n\n${statusPrompt}`;

      // LLM call
      const result = await chatDualPipeline(history, thinkingSystem, replySystem, {
        tools: getAllToolDefinitions(),
        senderLevel: level,
      });

      // Log thinking
      if (result.thinking) {
        appendDailyLogRaw(
          `[${timeString()}] ${persona} group thinking:\n${result.thinking}\n---\n`,
          persona,
        ).catch(() => {});
      }

      // Parse mood tag from raw text before trimming
      const moodParsed = parseMoodTag(result.text);
      const text = moodParsed.text.trim();
      return { persona, text, mood: moodParsed.mood, toolsUsed: result.toolsUsed, history };
    }),
  );

  // Collect posted replies for cross-talk pass
  const postedReplies: Array<{ persona: string; text: string }> = [];

  // Post results with interleaving
  let delay = 0;
  for (const result of results) {
    if (result.status === "rejected") continue;
    const { persona, text, mood, toolsUsed, history } = result.value;
    if (!text || text === "NO_ACTION") continue;

    await new Promise((resolve) => setTimeout(resolve, delay));
    const embed = buildStatusEmbed(persona, mood, toolsUsed);
    await sendAsPersona(message.channel, persona, text, client, embed);

    // Log to persona's group history
    const histFile = personaPath(persona, "history", `group-${message.channel.id}.md`);
    pushHistoryMessage(histFile, { role: "assistant", content: text });
    appendHistory(histFile, `${persona}: ${text}`).catch(() => {});
    appendDailyLogRaw(`[${timeString()}] ${persona} (群聊): ${text}\n`, persona).catch(() => {});

    console.log(`[GROUP] ${persona}: ${text.slice(0, 80)}`);

    postedReplies.push({ persona, text });
    delay = 1500;
  }

  // ---- Cross-talk pass: each persona can respond to what OTHERS said ----
  if (postedReplies.length >= 2) {
    for (const persona of personas) {
      // Skip personas that didn't participate in the first round
      const alreadyReplied = postedReplies.some((r) => r.persona === persona);
      if (!alreadyReplied) continue;

      // Build cross-talk context excluding THIS persona's own messages
      const othersText = postedReplies
        .filter((r) => r.persona !== persona)
        .map((r) => summarizePersonaMessage(r.text, r.persona))
        .join("\n");
      if (!othersText) continue; // nothing to cross-respond to

      const histFile = personaPath(persona, "history", `group-${message.channel.id}.md`);
      const history = await getHistory(histFile);

      // Append the cross-talk context as a system note
      history.push({
        role: "user",
        content: `[群聊中其他人的回复摘要：]\n${othersText}\n\n如果你有想回应的——可以简短回复。如果没什么要说的，输出 NO_ACTION。`,
      });

      const title = await masterTitle(persona);
      const soul = await loadSoul(persona);
      const replyPrompt = await assemblePrompt({
        persona,
        senderLevel: level,
        mode: "group-chat",
        variables: { PERSONA_TITLE: title, MASTER_NAME: "漓琊" },
      });
      const statusPrompt = await getStatusPrompt(persona);
      const replySystem = `${soul}\n\n${replyPrompt}\n\n${statusPrompt}`;

      const result = await chatDualPipeline(history, replySystem, replySystem, {
        senderLevel: level,
      });

      const crossParsed = parseMoodTag(result.text);
      const crossText = crossParsed.text.trim();
      if (crossText && crossText !== "NO_ACTION") {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const crossEmbed = buildStatusEmbed(persona, crossParsed.mood, result.toolsUsed);
        await sendAsPersona(message.channel, persona, crossText, client, crossEmbed);

        pushHistoryMessage(histFile, { role: "assistant", content: crossText });
        appendHistory(histFile, `${persona}: ${crossText}`).catch(() => {});
        console.log(`[GROUP] ${persona} (cross): ${crossText.slice(0, 80)}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

async function handleMessage(message: Message, client: Client): Promise<void> {
  if (!client.user) return;
  await ensureComplete(message);

  if (message.author.id === client.user.id) return;
  if (message.author.bot) return;

  const isDM = message.channel.isDMBased();

  // 1. Group chat channel — fan out to all personas
  const isGroup = await isGroupChatChannel(message.channel.id);
  if (isGroup && !isDM) {
    const masterId = await getMasterId();
    const hasTag = (await getMasterTag()) && message.content.includes((await getMasterTag()));
    const isMasterId = message.author.id === masterId;
    const classification = await classifySender(message.author.id, message.author.username);
    const level = (hasTag || isMasterId) ? "master" as const
      : classification.level;
    const senderName = level === "master" ? "漓琊 (Master)"
      : classification.sender;
    await handleGroupChatMessage(message, client, level, senderName);
    return;
  }

  // 2. Check if this channel is mapped to a specific persona
  const routedPersona = isDM
    ? await getDmPersona()
    : await getPersonaForChannel(message.channel.id);

  // 3. Fallback: read activePersona from data.json for backward compat
  const persona = routedPersona ?? await readActivePersona();

  await handlePersonaMessage(persona, message, client);
}

// ---------------------------------------------------------------------------
// Bot factory
// ---------------------------------------------------------------------------

export function createBot(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once("clientReady", async () => {
    const masterId = await getMasterId();
    console.log(`Elias is online. Master: ${masterId || "(not set — first DM will claim)"}`);

    // Set initial Discord presence from wanshi's status (default persona)
    const status = await getCurrentStatus("wanshi");
    client.user?.setActivity(status.label, { type: ActivityType.Custom });

    await registerSlashCommands(client);

    // Pre-warm DM channel if master is set
    if (masterId) {
      try {
        const user = await client.users.fetch(masterId);
        await user.createDM();
      } catch { /* DM pre-warm failed */ }
    }
  });

  client.on("interactionCreate", (interaction) => {
    handleInteraction(interaction).catch((err) =>
      console.error(`Slash command error: ${err}`),
    );
  });

  client.on("messageCreate", (message) => {
    handleMessage(message, client).catch((err) =>
      console.error(`Unhandled error in message handler: ${err}`),
    );
  });

  return client;
}
