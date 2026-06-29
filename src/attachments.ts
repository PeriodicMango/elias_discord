import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import os from "node:os";
import type { Message, Attachment } from "discord.js";
import { PATHS } from "../../../eliasCore/src/config.js";
import type { ImageBlock } from "../../../eliasCore/src/llm.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ATTACHMENTS_DIR = path.join(PATHS.knowledgeBase, "Elias", "attachments");

/** File extensions we can recognise as images. */
const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
]);

/** MIME type map for common image formats. */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** File extensions we can read as plain text. */
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".log", ".csv", ".json", ".xml", ".yaml", ".yml",
  ".toml", ".ini", ".cfg", ".env", ".js", ".ts", ".jsx", ".tsx",
  ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp", ".rb",
  ".php", ".swift", ".kt", ".sh", ".bash", ".zsh", ".ps1", ".sql",
  ".html", ".css", ".scss", ".less", ".graphql", ".vue", ".svelte",
]);

const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const PREVIEW_LINES = 3;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AttachmentResult {
  /** Formatted text note to inject into the user message. */
  note: string;
  /** Image content blocks for vision-capable models. */
  imageBlocks: ImageBlock[];
}

/**
 * Process all attachments on a Discord message. Downloads each one, extracts
 * text where possible, saves to the vault, and returns a formatted note plus
 * any image content blocks for vision-capable models.
 */
export async function processAttachments(message: Message): Promise<AttachmentResult> {
  if (message.attachments.size === 0) return { note: "", imageBlocks: [] };

  const notes: string[] = [];
  const imageBlocks: ImageBlock[] = [];

  for (const [, attachment] of message.attachments) {
    try {
      const result = await processOne(attachment);
      if (result.note) notes.push(result.note);
      if (result.imageBlock) imageBlocks.push(result.imageBlock);
    } catch (err) {
      console.error(`[ATTACH] Failed to process ${attachment.name}: ${err}`);
      notes.push(`[📎 ${attachment.name} — 处理失败: ${String(err).slice(0, 100)}]`);
    }
  }

  return {
    note: notes.length > 0 ? notes.join("\n") + "\n\n" : "",
    imageBlocks,
  };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function processOne(att: Attachment): Promise<{ note: string | null; imageBlock: ImageBlock | null }> {
  // Skip unreasonably large files
  if (att.size > MAX_DOWNLOAD_BYTES) {
    return {
      note: `[📎 ${att.name} — 文件过大 (${formatSize(att.size)}), 超过 ${formatSize(MAX_DOWNLOAD_BYTES)} 限制]`,
      imageBlock: null,
    };
  }

  const dateStr = new Date().toLocaleString("sv-SE", { timeZone: "Australia/Sydney" }).slice(0, 10);
  const sanitized = att.name.replace(/[^a-zA-Z0-9._一-鿿-]/g, "_");
  const safeName = `${att.id}-${sanitized}`;
  const vaultRelPath = `Elias/attachments/${dateStr}-${safeName}`;

  // Download
  const buffer = await downloadAttachment(att.url);

  // Ensure attachments directory exists
  await fs.mkdir(ATTACHMENTS_DIR, { recursive: true });

  // Save original file
  const originalPath = path.join(PATHS.knowledgeBase, vaultRelPath);
  await fs.writeFile(originalPath, buffer);

  const ext = path.extname(att.name).toLowerCase();

  // --- Images: convert to base64 content block ---
  if (IMAGE_EXTENSIONS.has(ext)) {
    const mime = IMAGE_MIME[ext] ?? "application/octet-stream";
    const b64 = buffer.toString("base64");
    const imageBlock: ImageBlock = {
      type: "image",
      source: { type: "base64", media_type: mime, data: b64 },
    };
    const note = `[🖼 ${att.name} · ${formatSize(att.size)} · 已附在消息中]`;
    return { note, imageBlock };
  }

  // --- Text / documents ---
  let extracted: string | null = null;
  let pageCount = 0;

  if (TEXT_EXTENSIONS.has(ext)) {
    extracted = buffer.toString("utf-8");
  } else if (ext === ".pdf") {
    const result = await extractPdf(buffer);
    extracted = result.text;
    pageCount = result.pageCount;
  } else if (ext === ".pptx") {
    const result = await extractPptx(buffer);
    extracted = result.text;
    pageCount = result.pageCount;
  }

  // Save extracted text as .md for read_attachment tool
  if (extracted) {
    const mdPath = ext ? originalPath.replace(/\.[^.]+$/, ".md") : originalPath + ".md";
    const frontmatter = [
      "---",
      "tags:",
      "  - elias",
      "  - elias/attachments",
      `original: ${att.name}`,
      `downloaded: ${new Date().toISOString()}`,
      pageCount > 0 ? `pages: ${pageCount}` : "",
      "---",
      "",
    ].filter(Boolean).join("\n");
    await fs.writeFile(mdPath, frontmatter + extracted, "utf-8");
  }

  // Build preview
  const preview = buildPreview(ext, extracted, pageCount);
  const vaultMdPath = ext ? vaultRelPath.replace(/\.[^.]+$/, ".md") : vaultRelPath + ".md";

  let note = `[📎 ${att.name}`;
  if (pageCount > 0) note += ` · ${pageCount} 页`;
  note += ` · ${formatSize(att.size)}`;
  note += ` → ${vaultMdPath || vaultRelPath}]`;

  if (extracted) {
    note += `\n${preview}`;
    note += `\n→ 用 read_attachment 分页阅读全文`;
  } else {
    note += `\n(二进制文件，原始文件已保存)`;
  }

  return { note, imageBlock: null };
}

async function downloadAttachment(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD_BYTES) {
      throw new Error(`File too large: ${formatSize(buf.length)}`);
    }
    return buf;
  } finally {
    clearTimeout(timeout);
  }
}

function buildPreview(ext: string, text: string | null, pageCount: number): string {
  if (!text) return `(无法提取文本预览)`;

  const lines = text.split("\n").filter((l) => l.trim()).slice(0, PREVIEW_LINES);
  if (lines.length === 0) return "(空文件)";

  const preview = lines
    .map((l) => l.slice(0, 120))
    .join("\n");
  return `预览: ${preview}${text.split("\n").length > PREVIEW_LINES ? "..." : ""}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// PDF extraction (pdf-parse)
// ---------------------------------------------------------------------------

async function extractPdf(buffer: Buffer): Promise<{ text: string; pageCount: number }> {
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    const textResult = await parser.getText();
    const text = textResult.pages.map((p) => p.text).join("\n\n");
    return { text, pageCount: textResult.total };
  } catch (err) {
    console.error(`[ATTACH] PDF extraction failed: ${err}`);
    return { text: "", pageCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// PPTX extraction (ZIP + XML)
// ---------------------------------------------------------------------------

async function extractPptx(buffer: Buffer): Promise<{ text: string; pageCount: number }> {
  try {
    // Write buffer to temp file, unzip, parse slide XMLs
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "elias-pptx-"));
    const tmpZip = path.join(tmpDir, "slides.pptx");

    await fs.writeFile(tmpZip, buffer);

    // Unzip (available on Ubuntu / WSL)
    execSync(`unzip -q -o "${tmpZip}" -d "${tmpDir}"`, { timeout: 10_000 });

    // Find and parse slide XMLs in order
    const slidesDir = path.join(tmpDir, "ppt", "slides");
    let slideFiles: string[];
    try {
      slideFiles = (await fs.readdir(slidesDir))
        .filter((f) => f.match(/^slide\d+\.xml$/))
        .sort((a, b) => {
          const na = parseInt(a.match(/^slide(\d+)\.xml$/)![1]!, 10);
          const nb = parseInt(b.match(/^slide(\d+)\.xml$/)![1]!, 10);
          return na - nb;
        });
    } catch {
      // No slides directory — might be a different PPTX structure
      await fs.rm(tmpDir, { recursive: true, force: true });
      return { text: "", pageCount: 0 };
    }

    const slides: string[] = [];
    for (let i = 0; i < slideFiles.length; i++) {
      const xml = await fs.readFile(path.join(slidesDir, slideFiles[i]!), "utf-8");
      const texts = extractXmlText(xml);
      if (texts.length > 0) {
        slides.push(`--- Slide ${i + 1} ---\n${texts.join("\n")}`);
      }
    }

    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });

    return { text: slides.join("\n\n"), pageCount: slides.length };
  } catch (err) {
    console.error(`[ATTACH] PPTX extraction failed: ${err}`);
    return { text: "", pageCount: 0 };
  }
}

/**
 * Extract text from PPTX slide XML.
 * Text in PPTX is stored in <a:t> elements within <a:p> (paragraph) elements.
 */
function extractXmlText(xml: string): string[] {
  const paragraphs: string[] = [];
  // Match each <a:p> ... </a:p> paragraph
  const pRegex = /<a:p[^>]*>([\s\S]*?)<\/a:p>/g;
  let pMatch;
  while ((pMatch = pRegex.exec(xml)) !== null) {
    const pContent = pMatch[1]!;
    const tRegex = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
    const texts: string[] = [];
    let tMatch;
    while ((tMatch = tRegex.exec(pContent)) !== null) {
      const text = tMatch[1]!.trim();
      if (text) texts.push(text);
    }
    if (texts.length > 0) paragraphs.push(texts.join(""));
  }
  return paragraphs;
}
