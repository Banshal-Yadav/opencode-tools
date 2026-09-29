import { tool } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import os from "os";

const SCRATCH_FILE = path.join(os.homedir(), ".config", "opencode", "brain", "scratch", "scratchpad.md");
const WORKING_NOTES_SECTION = "## 📝 Working Notes";

function getClockTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildEntryId(date: string): string {
  const compact = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const random = Math.random().toString(36).slice(2, 6);
  return `sp-${date}-${compact}-${random}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeEol(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function ensureScratchFile(): string {
  const dir = path.dirname(SCRATCH_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(SCRATCH_FILE)) {
    fs.writeFileSync(SCRATCH_FILE, `# 📝 Scratch Pad — Temporary Notes\n\n${WORKING_NOTES_SECTION}\n\n---\n\n`, "utf8");
  }
  let content = normalizeEol(fs.readFileSync(SCRATCH_FILE, "utf8"));
  if (!content.includes(WORKING_NOTES_SECTION)) {
    content = content.trimEnd() + "\n\n" + WORKING_NOTES_SECTION + "\n\n---\n\n";
    fs.writeFileSync(SCRATCH_FILE, content, "utf8");
  }
  return content;
}

function extractWorkingNotesBlock(content: string) {
  const sectionIndex = content.indexOf(WORKING_NOTES_SECTION);
  if (sectionIndex === -1) {
    return { before: content, section: WORKING_NOTES_SECTION + "\n\n", after: "" };
  }
  const afterHeader = content.slice(sectionIndex + WORKING_NOTES_SECTION.length);

  const lines = afterHeader.split("\n");
  let inEntry = false;
  let nextSectionOffset = afterHeader.length;
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineOffset = offset;
    offset += line.length + 1;

    if (/^### \[[^\]]+\] \d{4}-\d{2}-\d{2} \| ID:/.test(line)) {
      inEntry = true;
      continue;
    }

    if (inEntry) {
      if (line.trim() === "---") {
        inEntry = false;
      }
      continue;
    }

    if (/^## (?!#)/.test(line) && i > 0) {
      nextSectionOffset = lineOffset;
      break;
    }
  }

  return {
    before: content.slice(0, sectionIndex),
    section: WORKING_NOTES_SECTION + afterHeader.slice(0, nextSectionOffset),
    after: afterHeader.slice(nextSectionOffset),
  };
}

function listEntries(sectionContent: string) {
  const blocks = sectionContent.split(/(?=^### \[[^\]]+\] \d{4}-\d{2}-\d{2} \| ID:)/m);
  const entries: Array<{ time: string; date: string; id: string; content: string }> = [];
  for (const block of blocks) {
    const match = block.match(/^### \[([^\]]+)\] (\d{4}-\d{2}-\d{2}) \| ID: ([^\n\r]+)\r?\n([\s\S]*)$/);
    if (match) {
      const body = match[4].replace(/\s*---\s*$/, "").trim();
      entries.push({
        time: match[1].trim(),
        date: match[2].trim(),
        id: match[3].trim(),
        content: body,
      });
    }
  }
  return entries;
}

export default tool({
  description: "Dedicated scratchpad for temporary notes, checkpoints, mid-session context, and raw data dumps. Use for thoughts that don't belong in permanent memory. Use 'modify' to update an existing checkpoint by ID instead of delete+create.",
  args: {
    action: tool.schema
      .enum(["create", "read", "modify", "delete", "list", "clear"])
      .default("list")
      .describe("Action to perform. 'modify' updates an existing entry by ID — use this for checkpoint updates."),
    content: tool.schema.string().optional().describe("Note content for create/modify."),
    id: tool.schema.string().optional().describe("Entry ID for read/modify/delete."),
  },
  async execute(args) {
    ensureScratchFile();
    const content = normalizeEol(fs.readFileSync(SCRATCH_FILE, "utf8"));
    const { before, section, after } = extractWorkingNotesBlock(content);
    const entries = listEntries(section);

    // LIST
    if (args.action === "list") {
      if (entries.length === 0) return "Scratchpad is empty.";
      const lines = entries.map((e, i) => {
        const preview = e.content ? e.content.split("\n")[0] : "No content";
        return `${i + 1}. [${e.time}] ${e.date} | ID: ${e.id}\n   ${preview}`;
      });
      return `Scratchpad Entries (${entries.length}):\n\n${lines.join("\n\n")}`;
    }

    // CREATE
    if (args.action === "create") {
      if (!args.content) return "Error: content required.";
      const date = getTodayDate();
      const id = buildEntryId(date);
      const entry = `### [${getClockTime()}] ${date} | ID: ${id}\n${args.content.trim()}\n\n---\n\n`;
      const updatedSection = section.trimEnd() + "\n\n" + entry;
      fs.writeFileSync(SCRATCH_FILE, before + updatedSection + after, "utf8");
      return `Scratchpad note saved. ID: ${id}`;
    }

    // READ
    if (args.action === "read") {
      if (!args.id) {
        if (entries.length === 0) return "Scratchpad is empty.";
        return entries.map(e => `[${e.time}] ${e.date} | ID: ${e.id}\n${e.content}`).join("\n\n---\n\n");
      }
      const found = entries.find(e => e.id === args.id);
      if (!found) return `Note ${args.id} not found.`;
      return `[${found.time}] ${found.date} | ID: ${found.id}\n${found.content}`;
    }

    // MODIFY
    if (args.action === "modify") {
      if (!args.id) return "Error: id required for modify.";
      if (!args.content) return "Error: content required for modify.";
      const target = entries.find(e => e.id === args.id);
      if (!target) return `Error: could not locate entry ${args.id} for update.`;

      const escapedId = escapeRegExp(target.id);
      const entryPattern = new RegExp(
        `^### \\[[^\\]]+\\] ${escapeRegExp(target.date)} \\| ID: ${escapedId}\\r?\\n[\\s\\S]*?(?=^### \\[|$)`,
        "m"
      );

      if (!entryPattern.test(section)) {
        return `Error: could not locate entry ${args.id} for update.`;
      }

      const updatedEntry = `### [${target.time}] ${target.date} | ID: ${target.id}\n${args.content.trim()}\n\n---\n\n`;
      const updatedSection = section.replace(entryPattern, updatedEntry);

      fs.writeFileSync(SCRATCH_FILE, before + updatedSection + after, "utf8");
      return `Checkpoint ${args.id} updated.`;
    }

    // DELETE
    if (args.action === "delete") {
      if (!args.id) return "Error: id required.";
      const target = entries.find(e => e.id === args.id);
      if (!target) return `Note ${args.id} not found.`;

      const escapedId = escapeRegExp(target.id);
      const pattern = new RegExp(
        `^### \\[[^\\]]+\\] ${escapeRegExp(target.date)} \\| ID: ${escapedId}\\r?\\n[\\s\\S]*?(?=^### \\[|$)`,
        "m"
      );

      const updatedSection = section.replace(pattern, "");
      fs.writeFileSync(SCRATCH_FILE, before + updatedSection + after, "utf8");
      return `Deleted note ${args.id}.`;
    }

    // CLEAR
    if (args.action === "clear") {
      fs.writeFileSync(
        SCRATCH_FILE,
        `# 📝 Scratch Pad — Temporary Notes\n\n${WORKING_NOTES_SECTION}\n\n---\n\n`,
        "utf8"
      );
      return "Scratchpad cleared.";
    }

    return "Invalid action.";
  }
});
