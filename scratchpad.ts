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
  return `${date}-${compact}-${random}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureScratchFile(): string {
  const dir = path.dirname(SCRATCH_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(SCRATCH_FILE)) {
    fs.writeFileSync(SCRATCH_FILE, `# 📝 Scratch Pad — Temporary Notes\n\n${WORKING_NOTES_SECTION}\n\n---\n\n`, "utf8");
  }
  let content = fs.readFileSync(SCRATCH_FILE, "utf8");
  if (!content.includes(WORKING_NOTES_SECTION)) {
    content = content.trimEnd() + "\n\n" + WORKING_NOTES_SECTION + "\n\n---\n\n";
    fs.writeFileSync(SCRATCH_FILE, content, "utf8");
  }
  return content;
}

function extractWorkingNotesBlock(content: string) {
  const sectionIndex = content.indexOf(WORKING_NOTES_SECTION);
  const afterHeader = content.slice(sectionIndex + WORKING_NOTES_SECTION.length);
  const nextSectionMatch = afterHeader.match(/\n## /);
  const nextSectionOffset = nextSectionMatch ? afterHeader.indexOf(nextSectionMatch[0]) : afterHeader.length;

  return {
    before: content.slice(0, sectionIndex),
    section: WORKING_NOTES_SECTION + afterHeader.slice(0, nextSectionOffset),
    after: afterHeader.slice(nextSectionOffset),
  };
}

function listEntries(sectionContent: string) {
  const entryPattern = /### \[([^\]]+)\] (\d{4}-\d{2}-\d{2}) \| ID: ([^\n]+)\n([\s\S]*?)(?:\n---\n|$)/g;
  const entries: any[] = [];
  let match;
  while ((match = entryPattern.exec(sectionContent)) !== null) {
    entries.push({
      time: match[1].trim(),
      date: match[2].trim(),
      id: match[3].trim(),
      content: match[4].trim(),
    });
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
  async execute(args: any) {
    ensureScratchFile();
    const content = fs.readFileSync(SCRATCH_FILE, "utf8");
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

    // MODIFY — update checkpoint in place, preserves ID and timestamp header
    if (args.action === "modify") {
      if (!args.id) return "Error: id required for modify.";
      if (!args.content) return "Error: content required for modify.";
      const target = entries.find(e => e.id === args.id);
      if (!target) return `Note ${args.id} not found in scratchpad.`;

      const escapedId = escapeRegExp(target.id);
      const entryPattern = new RegExp(
        `(### \\[[^\\]]+\\] \\d{4}-\\d{2}-\\d{2} \\| ID: ${escapedId}\\n)([\\s\\S]*?)(\\n---\\n)`,
        "m"
      );

      if (!entryPattern.test(section)) {
        return `Error: could not locate entry ${args.id} for update.`;
      }

      // Append [updated HH:MM:SS] marker to header so history is traceable
      const updatedSection = section.replace(
        entryPattern,
        (_full: string, header: string, _body: string, sep: string) =>
          `${header.trimEnd()} [updated ${getClockTime()}]\n${args.content.trim()}${sep}`
      );

      fs.writeFileSync(SCRATCH_FILE, before + updatedSection + after, "utf8");
      return `Checkpoint ${args.id} updated.`;
    }

    // DELETE
    if (args.action === "delete") {
      if (!args.id) return "Error: id required.";
      const escapedId = escapeRegExp(args.id);
      const pattern = new RegExp(
        `### \\[[^\\]]+\\] \\d{4}-\\d{2}-\\d{2} \\| ID: ${escapedId}\\n[\\s\\S]*?\\n---\\n\\n?`,
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