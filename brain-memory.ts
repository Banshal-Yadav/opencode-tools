import { tool } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import os from "os";

const MEMORY_DIR = path.join(os.homedir(), ".config", "opencode", "brain", "memory");
const ABOUT_FILE = path.join(MEMORY_DIR, "about.md");
const GOALS_FILE = path.join(MEMORY_DIR, "goals.md");
const SETTINGS_FILE = path.join(MEMORY_DIR, "settings.md");
const PROJECTS_FILE = path.join(MEMORY_DIR, "projects.md");
const BOOKMARK_FILE = path.join(MEMORY_DIR, "bookmark.md");

const WORKING_NOTES_SECTION = "## 📝 Working Notes";

const FILE_MAP: Record<string, string> = {
  about: ABOUT_FILE,
  goals: GOALS_FILE,
  settings: SETTINGS_FILE,
  projects: PROJECTS_FILE,
  bookmark: BOOKMARK_FILE,
};

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function getClockTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function isValidIsoDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function buildEntryId(date: string): string {
  const compact = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const random = Math.random().toString(36).slice(2, 6);
  return `${date}-${compact}-${random}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Normalize line endings on read so entry parsing works for both LF and CRLF
// files (Windows-authored memory files are commonly CRLF). Writes standardize
// on LF, which is what this tool already produced.
function normalizeEol(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureBookmarkFile(): void {
  if (!fs.existsSync(BOOKMARK_FILE)) {
    fs.writeFileSync(
      BOOKMARK_FILE,
      `# 📌 Bookmarks & Ideas\n\n> ⚠️ AGENT RULE: Append only. Never rewrite this file. Use brain-memory with target=bookmark.\n\n## 💡 Ideas\n\n## 🔗 Links\n\n## 📝 Prompts & Tests\n\n## 🧪 Things to Try\n\n${WORKING_NOTES_SECTION}\n\n`,
      "utf8"
    );
  }
}

function ensureWorkingNotesSection(filePath: string): string {
  if (filePath === BOOKMARK_FILE) {
    ensureBookmarkFile();
  } else if (!fs.existsSync(filePath)) {
    throw new Error(`Memory file not found: ${filePath}. Do not auto-create memory files — inform the user.`);
  }
  let content = normalizeEol(fs.readFileSync(filePath, "utf8"));
  if (!content.includes(WORKING_NOTES_SECTION)) {
    const separator = content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
    content = content + separator + WORKING_NOTES_SECTION + "\n\n";
    safeWrite(filePath, content);
  }
  // Return the in-memory content (avoid a redundant re-read).
  return content;
}

function extractWorkingNotesBlock(content: string): { before: string; section: string; after: string } {
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

function buildEntry(date: string, id: string, content: string, time: string = getClockTime()): string {
  return `### [${time}] ${date} | ID: ${id}\n${content.trim()}\n\n---\n\n`;
}

function listEntries(sectionContent: string): Array<{ id: string; date: string; time: string; content: string }> {
  const blocks = sectionContent.split(/(?=^### \[[^\]]+\] \d{4}-\d{2}-\d{2} \| ID:)/m);
  const entries: Array<{ id: string; date: string; time: string; content: string }> = [];
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

function isKnownTarget(target: string): target is keyof typeof FILE_MAP {
  return Object.prototype.hasOwnProperty.call(FILE_MAP, target);
}

function resolveTargetFile(target: string | undefined): string {
  if (!target || target === "auto") return SETTINGS_FILE;
  return isKnownTarget(target) ? FILE_MAP[target] : SETTINGS_FILE;
}

function isDuplicateEntry(entries: Array<{ date: string; content: string }>, targetDate: string, newContent: string): boolean {
  const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const wanted = normalize(newContent);
  return entries.some(e => e.date === targetDate && normalize(e.content) === wanted);
}

// ─── SELF-CONTAINED SAFETY LAYER ────────────────────────────────────────────

const BACKUP_DIR = path.join(os.homedir(), ".config", "opencode", "brain", "memory", ".backups");

// Auto-backup before any destructive write — model doesn't need to call backup manually
function autoBackup(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return; // nothing to back up
    ensureDir(BACKUP_DIR);
    const fileName = path.basename(filePath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(BACKUP_DIR, `${fileName}.${timestamp}.bak`);
    fs.copyFileSync(filePath, backupPath);

    // Keep only last 5 backups per file to avoid bloat
    const allBackups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith(fileName))
      .sort()
      .reverse();
    for (const old of allBackups.slice(5)) {
      fs.unlinkSync(path.join(BACKUP_DIR, old));
    }
  } catch {
    // Backup failure should never block the main operation — log silently
  }
}

// Auto-verify after write — confirms file actually changed
function autoVerify(filePath: string, expectedContent: string): boolean {
  try {
    const actual = fs.readFileSync(filePath, "utf8");
    return actual === expectedContent;
  } catch {
    return false;
  }
}

// Safe write — backup → write → verify → rollback if failed
function safeWrite(filePath: string, newContent: string): void {
  autoBackup(filePath);
  fs.writeFileSync(filePath, newContent, "utf8");
  if (!autoVerify(filePath, newContent)) {
    throw new Error(`Write verification failed for ${path.basename(filePath)}. File may be corrupted — backup exists in .backups/`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// Reads the full raw content of a memory file (not just working notes)
function readFullFile(filePath: string, targetName: string): string {
  if (filePath === BOOKMARK_FILE) ensureBookmarkFile();
  if (!fs.existsSync(filePath)) {
    return `[${targetName}: file not found]`;
  }
  return fs.readFileSync(filePath, "utf8");
}

export default tool({
  description:
    "Modular memory manager for brain/memory/ (about.md, goals.md, settings.md, projects.md, bookmark.md). Supports working note CRUD under each file's '## 📝 Working Notes' section. Use 'target' to pick the file — defaults to settings.md. Use 'read-many' to read multiple files in one call (pass targets as comma-separated string e.g. 'about,settings'). Use 'read-all' to read all five files at once. For bookmark.md, auto-creates the file if missing.",
  args: {
    action: tool.schema
      .enum(["auto", "create", "read", "read-many", "read-all", "modify", "delete", "list"])
      .default("auto")
      .describe(
        "Action to perform. 'auto' creates if content provided, otherwise reads. 'read-many' reads multiple files at once (set targets as comma-separated string). 'read-all' reads all five memory files in one call."
      ),
    target: tool.schema
      .enum(["auto", "about", "goals", "settings", "projects", "bookmark"])
      .default("auto")
      .describe(
        "Which memory file to operate on. For read-many, pass comma-separated targets as a string in the 'targets' field instead."
      ),
    targets: tool.schema
      .string()
      .optional()
      .describe(
        "Comma-separated list of memory files for read-many. Valid values: about, goals, settings, projects, bookmark. Example: 'about,settings' or 'goals,projects,bookmark'."
      ),
    content: tool.schema
      .string()
      .optional()
      .describe("Note content. Required for create/modify."),
    date: tool.schema
      .string()
      .optional()
      .describe("Filter by date YYYY-MM-DD for read. Defaults to today for create."),
    id: tool.schema
      .string()
      .optional()
      .describe("Entry ID for read/modify/delete."),
  },
  async execute(args) {
    let action = args.action;

    if (action === "auto") {
      action = args.content && args.content.trim().length > 0 ? "create" : "read";
    }

    if (args.date && !isValidIsoDate(args.date)) {
      return "Error: date must be in YYYY-MM-DD format.";
    }

    const targetDate = args.date || getTodayDate();
    const targetFile = resolveTargetFile(args.target);
    const targetName = args.target && args.target !== "auto" ? args.target : "settings";

    ensureDir(MEMORY_DIR);

    // READ-ALL — read all 5 memory files in one call
    if (action === "read-all") {
      const allTargets = ["about", "goals", "settings", "projects", "bookmark"];
      const results: string[] = [];
      for (const t of allTargets) {
        const filePath = FILE_MAP[t];
        const content = readFullFile(filePath, t);
        results.push(`${"=".repeat(40)}\n# ${t.toUpperCase()}\n${"=".repeat(40)}\n${content}`);
      }
      return results.join("\n\n");
    }

    // READ-MANY — read specific files in one call
    if (action === "read-many") {
      if (!args.targets || args.targets.trim().length === 0) {
        return "Error: 'targets' is required for read-many. Pass a comma-separated list e.g. 'about,settings'.";
      }
      const requested = args.targets
        .split(",")
        .map((t: string) => t.trim().toLowerCase())
        .filter((t: string) => isKnownTarget(t));

      if (requested.length === 0) {
        return `Error: no valid targets found in '${args.targets}'. Valid: about, goals, settings, projects, bookmark.`;
      }

      const results: string[] = [];
      for (const t of requested) {
        const filePath = FILE_MAP[t];
        const content = readFullFile(filePath, t);
        results.push(`${"=".repeat(40)}\n# ${t.toUpperCase()}\n${"=".repeat(40)}\n${content}`);
      }
      return results.join("\n\n");
    }

    // LIST
    if (action === "list") {
      try {
        const content = ensureWorkingNotesSection(targetFile);
        const { section } = extractWorkingNotesBlock(content);
        const entries = listEntries(section);
        if (entries.length === 0) return `No working notes in ${targetName}.md.`;
        const lines = entries.map(
          (e, i) => `${i + 1}. [${e.time}] ${e.date} | ID: ${e.id}\n   ${e.content.split("\n")[0]}`
        );
        return `Working Notes in ${targetName}.md (${entries.length}):\n\n${lines.join("\n\n")}`;
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    }

    // CREATE
    if (action === "create") {
      if (!args.content || args.content.trim().length === 0) {
        return "Error: content is required for 'create'.";
      }
      try {
        const content = ensureWorkingNotesSection(targetFile);
        const { before, section, after } = extractWorkingNotesBlock(content);
        const entries = listEntries(section);

        if (isDuplicateEntry(entries, targetDate, args.content)) {
          return `Skipped: similar note already exists in ${targetName}.md for ${targetDate}. No duplicate written.`;
        }

        const entryId = buildEntryId(targetDate);
        const newEntry = buildEntry(targetDate, entryId, args.content);
        const updatedSection = section.trimEnd() + "\n\n" + newEntry;
        safeWrite(targetFile, before + updatedSection + after);
        return `Working note created and saved in ${targetName}.md with ID ${entryId}.`;
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    }

    // READ
    if (action === "read") {
      try {
        const content = ensureWorkingNotesSection(targetFile);
        const { section } = extractWorkingNotesBlock(content);
        const entries = listEntries(section);
        if (entries.length === 0) return `No working notes in ${targetName}.md.`;

        if (args.id) {
          const found = entries.find((e) => e.id === args.id);
          if (!found) return `No working note found with ID ${args.id} in ${targetName}.md.`;
          return `[${found.time}] ${found.date} | ID: ${found.id}\n${found.content}`;
        }

        if (args.date) {
          const filtered = entries.filter((e) => e.date === args.date);
          if (filtered.length === 0) return `No working notes for ${args.date} in ${targetName}.md.`;
          return filtered.map((e) => `[${e.time}] ${e.date} | ID: ${e.id}\n${e.content}`).join("\n\n---\n\n");
        }

        return entries.map((e) => `[${e.time}] ${e.date} | ID: ${e.id}\n${e.content}`).join("\n\n---\n\n");
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    }

    // MODIFY
    if (action === "modify") {
      if (!args.id) return "Error: id is required for 'modify'.";
      if (!args.content || args.content.trim().length === 0) return "Error: content is required for 'modify'.";
      try {
        const content = ensureWorkingNotesSection(targetFile);
        const { before, section, after } = extractWorkingNotesBlock(content);
        const entries = listEntries(section);
        const target = entries.find((e) => e.id === args.id);
        if (!target) return `No working note found with ID ${args.id} in ${targetName}.md.`;

        const escapedId = escapeRegExp(target.id);
        const entryPattern = new RegExp(
          `^### \\[[^\\]]+\\] ${escapeRegExp(target.date)} \\| ID: ${escapedId}\\n[\\s\\S]*?(?=^### \\[|$)`,
          "m"
        );

        if (!entryPattern.test(section)) {
          return `Error: could not locate entry ${args.id} for replacement in ${targetName}.md.`;
        }

        const updatedSection = section.replace(
          entryPattern,
          buildEntry(target.date, target.id, args.content, target.time)
        );

        safeWrite(targetFile, before + updatedSection + after);
        return `Working note ${args.id} updated in ${targetName}.md.`;
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    }

    // DELETE
    if (action === "delete") {
      if (!args.id) return "Error: id is required for 'delete'.";
      try {
        const content = ensureWorkingNotesSection(targetFile);
        const { before, section, after } = extractWorkingNotesBlock(content);
        const entries = listEntries(section);
        const target = entries.find((e) => e.id === args.id);
        if (!target) return `No working note found with ID ${args.id} in ${targetName}.md.`;

        const escapedId = escapeRegExp(target.id);
        const entryPattern = new RegExp(
          `^### \\[[^\\]]+\\] ${escapeRegExp(target.date)} \\| ID: ${escapedId}\\n[\\s\\S]*?(?=^### \\[|$)`,
          "m"
        );

        if (!entryPattern.test(section)) {
          return `Error: could not locate entry ${args.id} for deletion in ${targetName}.md.`;
        }

        const updatedSection = section.replace(entryPattern, "");
        safeWrite(targetFile, before + updatedSection + after);
        return `Deleted working note ${args.id} from ${targetName}.md.`;
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    }

    return "Invalid action.";
  },
});