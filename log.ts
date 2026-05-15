import { tool } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import os from "os";

const BRAIN_DIR = path.join(os.homedir(), ".config", "opencode", "brain");
const LOGS_DIR = path.join(BRAIN_DIR, "logs");
const PENDING_CONFIRMS_FILE = path.join(BRAIN_DIR, "config backups", ".pending-delete-confirms.json");

// ─── Types ────────────────────────────────────────────────────────────────────

type ParsedLogEntry = {
  index: number;
  rawLine: string;
  time: string | null;
  id: string | null;
  content: string;
};

type PendingConfirm = {
  date: string;
  entryCount: number;
  expiresAt: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildEntryId(date: string): string {
  const compact = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const random = Math.random().toString(36).slice(2, 6);
  return `${date}-${compact}-${random}`;
}

function isValidIsoDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function isValidClockTime(time: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time);
}

function parseClockTimeToSeconds(time: string): number | null {
  if (!isValidClockTime(time)) return null;
  const [h, m, s] = time.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function ensureFile(filePath: string, initialContent: string): void {
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, initialContent, "utf8");
}

// ─── Pending Confirmation Store ───────────────────────────────────────────────

function loadPendingConfirms(): Record<string, PendingConfirm> {
  try {
    if (!fs.existsSync(PENDING_CONFIRMS_FILE)) return {};
    return JSON.parse(fs.readFileSync(PENDING_CONFIRMS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function savePendingConfirms(confirms: Record<string, PendingConfirm>): void {
  ensureDir(path.dirname(PENDING_CONFIRMS_FILE));
  fs.writeFileSync(PENDING_CONFIRMS_FILE, JSON.stringify(confirms, null, 2), "utf8");
}

function setPendingConfirm(date: string, entryCount: number): void {
  const confirms = loadPendingConfirms();
  confirms[date] = { date, entryCount, expiresAt: Date.now() + 5 * 60 * 1000 };
  savePendingConfirms(confirms);
}

function consumePendingConfirm(date: string): boolean {
  const confirms = loadPendingConfirms();
  const entry = confirms[date];
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    delete confirms[date];
    savePendingConfirms(confirms);
    return false;
  }
  delete confirms[date];
  savePendingConfirms(confirms);
  return true;
}

function hasPendingConfirm(date: string): boolean {
  const confirms = loadPendingConfirms();
  const entry = confirms[date];
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    const updated = loadPendingConfirms();
    delete updated[date];
    savePendingConfirms(updated);
    return false;
  }
  return true;
}

// ─── Log Entry Parsing ────────────────────────────────────────────────────────

function parseLogEntryLine(line: string, index: number): ParsedLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("# Daily Log")) return null;

  const withId = line.match(/^\[([^\]]+)\]\s+\|\s+ID:([^|]+)\s+\|\s*(.*)$/);
  if (withId) {
    return { index, rawLine: line, time: withId[1].trim(), id: withId[2].trim(), content: withId[3].trim() };
  }

  const legacyDash = line.match(/^\[([^\]]+)\]\s*-\s*(.*)$/);
  if (legacyDash) {
    return { index, rawLine: line, time: legacyDash[1].trim(), id: null, content: legacyDash[2].trim() };
  }

  const timedNoId = line.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (timedNoId) {
    const content = timedNoId[2].trim().replace(/^\|\s*/, "").trim();
    return { index, rawLine: line, time: timedNoId[1].trim(), id: null, content };
  }

  return { index, rawLine: line, time: null, id: null, content: trimmed };
}

function collectLogEntries(raw: string): ParsedLogEntry[] {
  return raw
    .split(/\r?\n/)
    .map((line, index) => parseLogEntryLine(line, index))
    .filter((entry): entry is ParsedLogEntry => entry !== null);
}

function summarizeEntry(entry: ParsedLogEntry): string {
  return `[${entry.time ?? "NO_TIME"}] | ID:${entry.id ?? "NO_ID"} | ${entry.content}`;
}

function filterLogEntries(
  entries: ParsedLogEntry[],
  containsQuery: string,
  fromSeconds: number | null,
  toSeconds: number | null
): ParsedLogEntry[] {
  return entries.filter((entry) => {
    if (containsQuery && !entry.content.toLowerCase().includes(containsQuery)) return false;
    if (fromSeconds === null && toSeconds === null) return true;
    if (!entry.time) return false;
    const s = parseClockTimeToSeconds(entry.time);
    if (s === null) return false;
    if (fromSeconds !== null && s < fromSeconds) return false;
    if (toSeconds !== null && s > toSeconds) return false;
    return true;
  });
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

export default tool({
  description:
    "Unified log manager for recording and retrieving daily tasks and milestones. ONLY writes to brain/logs/. Never touches memory files.",
  args: {
    action: tool.schema
      .enum(["write", "read", "list", "entry-list", "migrate", "delete"])
      .default("write")
      .describe("Action to perform: write, read, list, entry-list, migrate, or delete."),
    content: tool.schema.string().optional().describe("Content to log (required for 'write')."),
    contains: tool.schema.string().optional().describe("Text filter for read/entry-list (case-insensitive)."),
    fromTime: tool.schema.string().optional().describe("Lower time bound HH:mm:ss for filtering."),
    toTime: tool.schema.string().optional().describe("Upper time bound HH:mm:ss for filtering."),
    date: tool.schema.string().optional().describe("Date in YYYY-MM-DD format. Defaults to today."),
    id: tool.schema.string().optional().describe("Entry ID for delete scope=entry. Omit to delete latest."),
    scope: tool.schema.enum(["entry", "day"]).default("entry").describe("Delete scope."),
    dryRun: tool.schema.boolean().default(false).describe("Preview what would be deleted without changing files."),
    userConfirmed: tool.schema
      .boolean()
      .default(false)
      .describe(
        "For scope=day deletes only. Set true ONLY after the user has explicitly replied 'yes'. NEVER set this yourself."
      ),
  },

  async execute(args) {
    try {
      const targetDate = args.date || getTodayDate();

      if (args.date && !isValidIsoDate(args.date)) return "Error: date must be YYYY-MM-DD.";
      if (args.fromTime && !isValidClockTime(args.fromTime)) return "Error: fromTime must be HH:mm:ss.";
      if (args.toTime && !isValidClockTime(args.toTime)) return "Error: toTime must be HH:mm:ss.";

      const fromSeconds = args.fromTime ? parseClockTimeToSeconds(args.fromTime) : null;
      const toSeconds = args.toTime ? parseClockTimeToSeconds(args.toTime) : null;
      if (fromSeconds !== null && toSeconds !== null && fromSeconds > toSeconds) {
        return "Error: fromTime must be <= toTime.";
      }

      const containsQuery = args.contains?.trim().toLowerCase() ?? "";
      const hasFilters = containsQuery.length > 0 || fromSeconds !== null || toSeconds !== null;
      const logFile = path.join(LOGS_DIR, `${targetDate}.md`);

      // ── LIST ──
      if (args.action === "list") {
        if (!fs.existsSync(LOGS_DIR)) return "No logs found yet.";
        const files = fs
          .readdirSync(LOGS_DIR, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith(".md"))
          .map((e) => e.name)
          .sort((a, b) => b.localeCompare(a));
        return files.length === 0 ? "No logs found yet." : `Available logs:\n${files.join("\n")}`;
      }

      // ── ENTRY-LIST ──
      if (args.action === "entry-list") {
        if (!fs.existsSync(logFile)) return `No log found for ${targetDate}.`;
        const entries = collectLogEntries(fs.readFileSync(logFile, "utf8"));
        if (entries.length === 0) return `No entries found for ${targetDate}.`;
        const filtered = hasFilters ? filterLogEntries(entries, containsQuery, fromSeconds, toSeconds) : entries;
        if (filtered.length === 0) return `No matching entries for ${targetDate}.`;
        return `Entries for ${targetDate}:\n${filtered.map((e, i) => `${i + 1}. ${summarizeEntry(e)}`).join("\n")}`;
      }

      // ── READ ──
      if (args.action === "read") {
        if (!fs.existsSync(logFile)) return `No log found for ${targetDate}.`;
        const raw = fs.readFileSync(logFile, "utf8");
        if (!hasFilters) return raw;
        const entries = collectLogEntries(raw);
        const filtered = filterLogEntries(entries, containsQuery, fromSeconds, toSeconds);
        if (filtered.length === 0) return `No matching entries for ${targetDate}.`;
        return `Filtered entries for ${targetDate}:\n${filtered.map(summarizeEntry).join("\n")}`;
      }

      // ── MIGRATE ──
      if (args.action === "migrate") {
        if (!fs.existsSync(logFile)) return `No log found for ${targetDate}.`;
        const raw = fs.readFileSync(logFile, "utf8");
        const entries = collectLogEntries(raw);
        const lines = raw.split(/\r?\n/);
        const usedIds = new Set(entries.filter((e) => e.id).map((e) => e.id!));
        let migrated = 0;
        let skipped = 0;

        for (const entry of entries) {
          if (entry.id) continue;
          if (!entry.time) { skipped++; continue; }
          let newId = buildEntryId(targetDate);
          while (usedIds.has(newId)) newId = buildEntryId(targetDate);
          usedIds.add(newId);
          lines[entry.index] = `[${entry.time}] | ID:${newId} | ${entry.content}`;
          migrated++;
        }

        if (migrated === 0) return `No legacy entries without IDs found for ${targetDate}.`;
        let updated = lines.join("\n");
        if (!updated.endsWith("\n")) updated += "\n";
        fs.writeFileSync(logFile, updated, "utf8");
        return `Migrated ${migrated} entries in ${targetDate}.md.${skipped > 0 ? ` Skipped ${skipped} non-standard lines.` : ""}`;
      }

      // ── DELETE ──
      if (args.action === "delete") {
        if (!fs.existsSync(logFile)) return `No log found for ${targetDate}.`;
        const raw = fs.readFileSync(logFile, "utf8");
        const entries = collectLogEntries(raw);

        // scope=day — requires explicit yes from user
        if (args.scope === "day") {
          if (!args.date) return "Error: date is required for scope=day delete.";

          if (args.dryRun) {
            return `Dry run: would delete full-day log ${targetDate}.md (${entries.length} entries).\n\n${raw}`;
          }

          // Step 1 — no pending confirmation, show entries and ask user
          if (!hasPendingConfirm(targetDate)) {
            setPendingConfirm(targetDate, entries.length);
            const preview = entries.slice(0, 3).map(summarizeEntry).join("\n");
            const more = entries.length > 3 ? `\n...and ${entries.length - 3} more.` : "";
            return [
              `This will permanently delete all ${entries.length} log entries for ${targetDate}:`,
              preview + more,
              ``,
              `Reply 'yes' to confirm deletion, or 'no' to cancel. Expires in 5 minutes.`,
              `STOP — do not proceed until the user replies.`,
            ].join("\n");
          }

          // Step 2 — pending confirmation exists, but userConfirmed not set
          if (!args.userConfirmed) {
            return `Waiting for user reply. Ask: "Delete all logs for ${targetDate}? Reply yes or no."`;
          }

          // Step 3 — userConfirmed=true, consume and delete
          const valid = consumePendingConfirm(targetDate);
          if (!valid) {
            return `Confirmation expired for ${targetDate}. Start over — call delete scope=day again without userConfirmed.`;
          }

          fs.unlinkSync(logFile);
          return `Deleted ${targetDate}.md — ${entries.length} entries removed.`;
        }

        // scope=entry
        if (entries.length === 0) return `No entries found for ${targetDate}.`;

        let target: ParsedLogEntry | null = null;
        if (args.id) {
          target = entries.find((e) => e.id === args.id) ?? null;
          if (!target) return `No entry found with ID ${args.id} on ${targetDate}.`;
        } else {
          target = entries[entries.length - 1];
        }

        if (args.dryRun) {
          return `Dry run: would delete entry from ${targetDate}.\n${summarizeEntry(target)}`;
        }

        const lines = raw.split(/\r?\n/);
        const removed = lines[target.index].trim();
        lines.splice(target.index, 1);
        let updated = lines.join("\n").replace(/\n{4,}/g, "\n\n\n");
        if (!updated.endsWith("\n")) updated += "\n";
        fs.writeFileSync(logFile, updated, "utf8");
        return `Deleted entry from ${targetDate}. Removed: ${removed}`;
      }

      // ── WRITE ──
      if (args.action === "write") {
        if (!args.content) return "Error: content is required for 'write'.";
        ensureDir(LOGS_DIR);
        const timestamp = new Date().toLocaleTimeString("en-US", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        const entryId = buildEntryId(targetDate);
        const logEntry = `[${timestamp}] | ID:${entryId} | ${args.content.trim()}\n`;
        ensureFile(logFile, `# Daily Log - ${targetDate}\n\n`);
        fs.appendFileSync(logFile, logEntry, "utf8");
        return `Logged to ${targetDate}.md | ID:${entryId}`;
      }

      return "Error: invalid action.";
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error: ${message}`;
    }
  },
});