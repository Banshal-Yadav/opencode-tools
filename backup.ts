import { tool } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import os from "os";

const MEMORY_DIR = path.join(os.homedir(), ".config", "opencode", "brain", "memory");
const BACKUP_DIR = path.join(os.homedir(), ".config", "opencode", "brain", "backups");
const DRAFTS_DIR = path.join(os.homedir(), ".config", "opencode", "brain", "drafts");
const MEMORY_FILES = ["about.md", "goals.md", "settings.md", "bookmark.md", "projects.md"];
const MEMORY_TARGETS = ["about", "goals", "settings", "bookmark", "projects"] as const;
const CREATE_RETENTION_DAYS = 2;
const ALL_BACKUP_TARGETS = [...MEMORY_TARGETS, "drafts"] as const;

type BackupTarget = (typeof ALL_BACKUP_TARGETS)[number];

type BackupEntry = {
    target: BackupTarget;
    name: string;
    fullPath: string;
    isDirectory: boolean;
    date: string;
};

type ResolvedBackup = BackupEntry | { error: string };

function getTodayDate(): string {
    return new Date().toISOString().slice(0, 10);
}

function ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function getTargetBackupDir(target: BackupTarget): string {
    return path.join(BACKUP_DIR, target);
}

function parseBackupName(name: string): { date: string; target: BackupTarget } | null {
    const fileMatch = name.match(
        /^(\d{4}-\d{2}-\d{2})-(?:\d+-)?(about\.md|goals\.md|settings\.md|bookmark\.md|projects\.md)$/
    );
    if (fileMatch) {
        return {
            date: fileMatch[1],
            target: fileMatch[2].replace(".md", "") as BackupTarget,
        };
    }

    const draftsMatch = name.match(/^(\d{4}-\d{2}-\d{2})-(?:\d+-)?drafts$/);
    if (draftsMatch) {
        return {
            date: draftsMatch[1],
            target: "drafts",
        };
    }

    return null;
}

function buildUniqueBackupPath(dirPath: string, baseName: string): string {
    let candidate = path.join(dirPath, baseName);
    if (!fs.existsSync(candidate)) return candidate;

    const prefixMatch = baseName.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
    let counter = 0;

    while (fs.existsSync(candidate)) {
        const stamp = Date.now() + counter;
        const stampedName = prefixMatch
            ? `${prefixMatch[1]}-${stamp}-${prefixMatch[2]}`
            : `${stamp}-${baseName}`;
        candidate = path.join(dirPath, stampedName);
        counter += 1;
    }

    return candidate;
}

function collectBackupEntriesFromDir(dirPath: string, onlyTarget?: BackupTarget): BackupEntry[] {
    if (!fs.existsSync(dirPath)) return [];

    const entries: BackupEntry[] = [];

    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const parsed = parseBackupName(entry.name);
        if (!parsed) continue;
        if (onlyTarget && parsed.target !== onlyTarget) continue;

        entries.push({
            target: parsed.target,
            name: entry.name,
            fullPath: path.join(dirPath, entry.name),
            isDirectory: entry.isDirectory(),
            date: parsed.date,
        });
    }

    return entries;
}

function collectAllBackupEntries(): BackupEntry[] {
    const entries: BackupEntry[] = [];

    for (const target of ALL_BACKUP_TARGETS) {
        entries.push(...collectBackupEntriesFromDir(getTargetBackupDir(target), target));
    }

    // Backward compatibility for legacy backups stored directly in BACKUP_DIR.
    entries.push(...collectBackupEntriesFromDir(BACKUP_DIR));

    return entries.sort((a, b) => b.name.localeCompare(a.name));
}

function getCutoffDate(keepDays: number): Date {
    const normalizedKeepDays = Math.max(1, Math.floor(keepDays));
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - (normalizedKeepDays - 1));
    return cutoff;
}

function pruneOldBackupsForTarget(target: BackupTarget, keepDays: number): number {
    const cutoff = getCutoffDate(keepDays);
    const entries = collectAllBackupEntries().filter((entry) => entry.target === target);

    let pruned = 0;

    for (const entry of entries) {
        const entryDate = new Date(entry.date + "T00:00:00");
        if (Number.isNaN(entryDate.getTime())) continue;
        if (entryDate >= cutoff) continue;

        if (entry.isDirectory) {
            fs.rmSync(entry.fullPath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(entry.fullPath);
        }

        pruned += 1;
    }

    return pruned;
}

function migrateLegacyRootBackups(): string[] {
    if (!fs.existsSync(BACKUP_DIR)) return [];

    const moved: string[] = [];
    const legacyEntries = collectBackupEntriesFromDir(BACKUP_DIR);

    for (const legacy of legacyEntries) {
        const targetDir = getTargetBackupDir(legacy.target);
        ensureDir(targetDir);

        const destination = buildUniqueBackupPath(targetDir, legacy.name);

        try {
            fs.renameSync(legacy.fullPath, destination);
        } catch {
            if (legacy.isDirectory) {
                fs.cpSync(legacy.fullPath, destination, { recursive: true });
                fs.rmSync(legacy.fullPath, { recursive: true, force: true });
            } else {
                fs.copyFileSync(legacy.fullPath, destination);
                fs.unlinkSync(legacy.fullPath);
            }
        }

        moved.push(`Moved legacy backup ${legacy.name} -> ${legacy.target}/${path.basename(destination)}`);
    }

    return moved;
}

function resolveBackupEntry(backupRef: string): ResolvedBackup {
    if (backupRef.includes("/") || backupRef.includes("\\")) {
        const normalized = backupRef.replace(/[\\/]+/g, path.sep);
        const fullPath = path.join(BACKUP_DIR, normalized);

        if (!fs.existsSync(fullPath)) {
            return { error: `Error: backup '${backupRef}' not found in ${BACKUP_DIR}.` };
        }

        const parsed = parseBackupName(path.basename(fullPath));
        if (!parsed) {
            return { error: `Error: backup '${backupRef}' does not match expected backup naming format.` };
        }

        const stat = fs.statSync(fullPath);
        return {
            target: parsed.target,
            name: path.basename(fullPath),
            fullPath,
            isDirectory: stat.isDirectory(),
            date: parsed.date,
        };
    }

    const matches = collectAllBackupEntries().filter((entry) => entry.name === backupRef);

    if (matches.length === 0) {
        return { error: `Error: backup '${backupRef}' not found. Use action='list' to see available backups.` };
    }

    if (matches.length > 1) {
        const options = matches.map((match) => `${match.target}/${match.name}`).join("\n");
        return {
            error:
                `Error: backup name '${backupRef}' is ambiguous. Use one of these target-qualified values:\n` +
                options,
        };
    }

    return matches[0];
}

function listBackups(): string {
    const entries = collectAllBackupEntries();
    if (entries.length === 0) return "No backups found yet.";

    const lines = entries.map((entry) => `${entry.target}/${entry.name}`);
    return `Available backups (${entries.length}):\n${lines.join("\n")}`;
}

function pruneOldBackups(keepDays: number): string {
    if (!fs.existsSync(BACKUP_DIR)) return "No backup directory found.";

    let pruned = 0;
    for (const target of ALL_BACKUP_TARGETS) {
        pruned += pruneOldBackupsForTarget(target, keepDays);
    }

    return pruned > 0
        ? `Pruned ${pruned} backup(s) older than ${Math.max(1, Math.floor(keepDays))} days.`
        : `No backups older than ${Math.max(1, Math.floor(keepDays))} days found.`;
}

export default tool({
    description:
        "Memory backup manager. Creates dated backups of about.md, goals.md, settings.md, bookmark.md, projects.md, and brain/drafts before destructive actions. Backups are organized under target folders and create auto-prunes old backups. AGENTS: Call backup with action='create' BEFORE editing any memory file. Supports create/list/restore/prune.",
    args: {
        action: tool.schema
            .enum(["create", "list", "restore", "prune"])
            .default("create")
            .describe(
                "Action: 'create' backs up all/one memory file, 'list' shows available backups, 'restore' restores a backup, 'prune' deletes backups older than N days."
            ),
        target: tool.schema
            .enum(["all", "about", "goals", "settings", "bookmark", "projects", "drafts"])
            .default("all")
            .describe("Which file to back up. Defaults to 'all'. Used for create and restore."),
        backup_file: tool.schema
            .string()
            .optional()
            .describe("Backup reference to restore. Prefer target-qualified value from list output (e.g. 'settings/2026-04-24-settings.md' or 'drafts/2026-04-24-drafts'). Required for restore."),
        keep_days: tool.schema
            .number()
            .default(30)
            .describe("For prune: delete backups older than this many days. Default 30."),
    },
    async execute(args) {
        ensureDir(BACKUP_DIR);
        for (const target of ALL_BACKUP_TARGETS) {
            ensureDir(getTargetBackupDir(target));
        }

        const migrationNotes = migrateLegacyRootBackups();
        const today = getTodayDate();

        // CREATE
        if (args.action === "create") {
            const targets =
                args.target === "all"
                    ? [...MEMORY_FILES, "drafts"]
                    : MEMORY_TARGETS.includes(args.target as any)
                        ? [`${args.target}.md`]
                        : ["drafts"];

            const results: string[] = [...migrationNotes];

            for (const filename of targets) {
                const target = filename === "drafts"
                    ? "drafts"
                    : (filename.replace(".md", "") as BackupTarget);
                const targetDir = getTargetBackupDir(target);

                const removed = pruneOldBackupsForTarget(target, CREATE_RETENTION_DAYS);
                if (removed > 0) {
                    results.push(
                        `Pruned ${removed} old backup(s) for ${target}/ older than ${CREATE_RETENTION_DAYS} days.`
                    );
                }

                const srcPath = path.join(MEMORY_DIR, filename);
                if (filename === "drafts") {
                    if (!fs.existsSync(DRAFTS_DIR)) {
                        results.push("Skipped drafts — folder not found.");
                        continue;
                    }

                    const backupName = `${today}-drafts`;
                    const finalDest = buildUniqueBackupPath(targetDir, backupName);

                    fs.cpSync(DRAFTS_DIR, finalDest, { recursive: true });
                    results.push(`Backed up drafts folder -> drafts/${path.basename(finalDest)}`);
                    continue;
                }

                if (!fs.existsSync(srcPath)) {
                    results.push(`Skipped ${filename} — file not found.`);
                    continue;
                }

                const backupName = `${today}-${filename}`;
                const finalDest = buildUniqueBackupPath(targetDir, backupName);

                fs.copyFileSync(srcPath, finalDest);
                results.push(`Backed up ${filename} -> ${target}/${path.basename(finalDest)}`);
            }

            return results.join("\n");
        }

        // LIST
        if (args.action === "list") {
            const listResult = listBackups();
            if (migrationNotes.length === 0) return listResult;
            return `${migrationNotes.join("\n")}\n${listResult}`;
        }

        // RESTORE
        if (args.action === "restore") {
            if (!args.backup_file) {
                return "Error: backup_file is required for restore. Use action='list' to see available backups.";
            }

            const resolved = resolveBackupEntry(args.backup_file);
            if ("error" in resolved) {
                return resolved.error;
            }

            if (resolved.target === "drafts") {
                if (!resolved.isDirectory) {
                    return `Error: drafts backup '${resolved.name}' is not a valid backup folder.`;
                }

                // Safety: backup current drafts before destructive restore.
                if (fs.existsSync(DRAFTS_DIR)) {
                    const safetyDir = getTargetBackupDir("drafts");
                    const finalSafetyDrafts = buildUniqueBackupPath(safetyDir, `${today}-pre-restore-drafts`);
                    fs.cpSync(DRAFTS_DIR, finalSafetyDrafts, { recursive: true });
                }

                if (fs.existsSync(DRAFTS_DIR)) {
                    fs.rmSync(DRAFTS_DIR, { recursive: true, force: true });
                }
                fs.cpSync(resolved.fullPath, DRAFTS_DIR, { recursive: true });
                return `Restored drafts folder from ${resolved.target}/${resolved.name}.`;
            }

            if (resolved.isDirectory) {
                return `Error: backup '${resolved.target}/${resolved.name}' is a directory. Expected a file backup.`;
            }

            const targetFilename = `${resolved.target}.md`;
            if (!MEMORY_FILES.includes(targetFilename)) {
                return `Error: '${targetFilename}' is not a recognized memory file. Expected one of: ${MEMORY_FILES.join(", ")}.`;
            }

            const targetPath = path.join(MEMORY_DIR, targetFilename);

            // Safety: backup current file before restoring.
            if (fs.existsSync(targetPath)) {
                const safetyDir = getTargetBackupDir(resolved.target);
                const safetyBackup = buildUniqueBackupPath(safetyDir, `${today}-pre-restore-${targetFilename}`);
                fs.copyFileSync(targetPath, safetyBackup);
            }

            fs.copyFileSync(resolved.fullPath, targetPath);
            return `Restored ${targetFilename} from ${resolved.target}/${resolved.name}.`;
        }

        // PRUNE
        if (args.action === "prune") {
            const pruneResult = pruneOldBackups(args.keep_days ?? 30);
            if (migrationNotes.length === 0) return pruneResult;
            return `${migrationNotes.join("\n")}\n${pruneResult}`;
        }

        return "Invalid action.";
    },
});