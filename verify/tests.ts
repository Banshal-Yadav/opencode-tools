// Verification suite for the OpenCode tools. Compiles with tsc (see
// tsconfig.build.json) then runs under node. Sets a temp HOME before importing
// the tool modules so every tool writes into an isolated brain directory.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TMP_HOME = path.join(os.tmpdir(), "opencode-tools-verify-home");
fs.rmSync(TMP_HOME, { recursive: true, force: true });
fs.mkdirSync(TMP_HOME, { recursive: true });
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const BRAIN = path.join(TMP_HOME, ".config", "opencode", "brain");
const MEMORY = path.join(BRAIN, "memory");
const LOGS = path.join(BRAIN, "logs");
const SCRATCH = path.join(BRAIN, "scratch");
const BACKUPS = path.join(BRAIN, "backups");
const DRAFTS = path.join(BRAIN, "drafts");
const MUSIC = path.join(BRAIN, "music");

// ─── tiny test framework ─────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? " — " + detail : ""}`);
    console.log(`  FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

function section(title: string) {
  console.log(`\n# ${title}`);
}

function write(filePath: string, content: string, eol: "\n" | "\r\n" = "\n") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = eol === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
  fs.writeFileSync(filePath, body, "utf8");
}

function read(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

// ─── tools (imported after HOME override) ────────────────────────────────────
async function main() {
  const brainMemory = (await import("../brain-memory.js")).default;
  const logTool = (await import("../log.js")).default;
  const scratchpad = (await import("../scratchpad.js")).default;
  const backup = (await import("../backup.js")).default;

  const call = (tool: any, args: any) => Promise.resolve(tool.execute(args));

  // ═════════════════════════════════════════════════════════════════════════
  section("brain-memory: legacy CRLF data");

  // Old-format working notes with CRLF line endings, containing a horizontal
  // rule and a "## " heading inside a note body.
  write(
    path.join(MEMORY, "settings.md"),
    `# Settings

## 📝 Working Notes
### [10:00:00] 2026-01-01 | ID: 2026-01-01-abc123
first note body

---

### [11:00:00] 2026-01-02 | ID: 2026-01-02-def456
second note with
## a heading inside

---
`,
    "\r\n",
  );

  let res = await call(brainMemory, { action: "list", target: "settings" });
  check(
    "list finds legacy CRLF notes",
    typeof res === "string" && res.includes("abc123") && res.includes("def456"),
    JSON.stringify(res).slice(0, 200),
  );

  res = await call(brainMemory, { action: "read", target: "settings", id: "2026-01-02-def456" });
  check(
    "read legacy CRLF note by id",
    typeof res === "string" && res.includes("a heading inside"),
    JSON.stringify(res).slice(0, 200),
  );

  section("brain-memory: create preserves old data");

  res = await call(brainMemory, {
    action: "create",
    target: "settings",
    content: "new note added after migration",
  });
  const settingsContent = read(path.join(MEMORY, "settings.md"));
  check("create reports success", typeof res === "string" && res.includes("saved"), "");
  check(
    "create keeps legacy notes",
    settingsContent.includes("first note body") && settingsContent.includes("second note with"),
    "",
  );
  check(
    "create keeps the original heading (no duplicate section)",
    (settingsContent.match(/## 📝 Working Notes/g) || []).length === 1,
    "",
  );
  check("create wrote the new note", settingsContent.includes("new note added after migration"), "");

  section("brain-memory: note bodies with --- and ## survive round-trip");

  res = await call(brainMemory, {
    action: "create",
    target: "settings",
    content: "part one\n\n---\n\npart two after rule\n\n## Subhead\nmore",
  });
  const afterRule = read(path.join(MEMORY, "settings.md"));
  res = await call(brainMemory, { action: "list", target: "settings" });
  check(
    "entry containing --- is still parseable (list count grows)",
    typeof res === "string" && (res.match(/ID:/g) || []).length >= 4,
    JSON.stringify(res).slice(0, 300),
  );
  check("body text after --- preserved", afterRule.includes("part two after rule"), "");

  section("brain-memory: delete non-existent must not corrupt");

  const beforeDelete = read(path.join(MEMORY, "settings.md"));
  res = await call(brainMemory, { action: "delete", target: "settings", id: "does-not-exist-999" });
  const afterDelete = read(path.join(MEMORY, "settings.md"));
  check(
    "delete unknown id reports not-found",
    typeof res === "string" && /not found|no |could not/i.test(res),
    JSON.stringify(res).slice(0, 200),
  );
  check("delete unknown id leaves file intact", beforeDelete === afterDelete, "");

  section("brain-memory: read-many");

  write(
    path.join(MEMORY, "about.md"),
    `# About
- Name: Tester

## 📝 Working Notes
`,
  );
  res = await call(brainMemory, { action: "read-many", targets: "about,settings" });
  check(
    "read-many returns both files",
    typeof res === "string" && res.includes("ABOUT") && res.includes("SETTINGS"),
    JSON.stringify(res).slice(0, 200),
  );

  // ═════════════════════════════════════════════════════════════════════════
  section("log: legacy mixed data (bullets + headings)");

  write(
    path.join(LOGS, "2026-01-01.md"),
    `# Daily Log — 2026-01-01

- 10:00:00 | ID: 2026-01-01-aaa | did a thing
- 11:00:00 | ID: 2026-01-01-bbb | did another thing

## Misc

some stray bullet
`,
  );

  res = await call(logTool, { action: "entry-list", date: "2026-01-01" });
  check(
    "entry-list lists only real entries",
    typeof res === "string" && !/# Misc/i.test(res) && !/stray bullet/i.test(res),
    JSON.stringify(res).slice(0, 400),
  );
  check(
    "entry-list finds both real entries",
    typeof res === "string" && res.includes("aaa") && res.includes("bbb"),
    JSON.stringify(res).slice(0, 400),
  );

  res = await call(logTool, { action: "delete", scope: "entry", date: "2026-01-01" });
  const afterLogDelete = read(path.join(LOGS, "2026-01-01.md"));
  check(
    "default delete removes last REAL entry (bbb), not the heading",
    afterLogDelete.includes("bbb") === false && afterLogDelete.includes("# Misc"),
    JSON.stringify(afterLogDelete).slice(0, 300),
  );
  check("default delete keeps earlier entry", afterLogDelete.includes("aaa"), "");

  section("log: multi-line content sanitized");

  res = await call(logTool, { action: "write", content: "line one\nline two" });
  const logAfterWrite = read(path.join(LOGS, new Date().toISOString().slice(0, 10) + ".md"));
  const contentLines = logAfterWrite
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0 && !l.startsWith("#"));
  check(
    "multi-line content does not create extra pseudo-entries",
    !logAfterWrite.includes("\nline two\n") && contentLines.some((l) => l.includes("line one")),
    JSON.stringify(logAfterWrite).slice(0, 300),
  );

  // ═════════════════════════════════════════════════════════════════════════
  section("scratchpad: legacy CRLF note with --- and ## in body");

  write(
    path.join(SCRATCH, "scratchpad.md"),
    `# 📝 Scratch Pad — Temporary Notes

## 📝 Working Notes
### [09:00:00] 2026-01-01 | ID: sp-old-1
old note body
with a rule below

---

### [09:30:00] 2026-01-02 | ID: sp-old-2
## not a section heading
body after hash heading

---

`,
    "\r\n",
  );

  res = await call(scratchpad, { action: "list" });
  check(
    "scratchpad list finds legacy notes",
    typeof res === "string" && res.includes("sp-old-1") && res.includes("sp-old-2"),
    JSON.stringify(res).slice(0, 400),
  );

  res = await call(scratchpad, { action: "read", id: "sp-old-2" });
  check(
    "scratchpad read legacy note with ## in body",
    typeof res === "string" && res.includes("body after hash heading"),
    JSON.stringify(res).slice(0, 300),
  );

  section("scratchpad: modify then re-modify with same id");

  res = await call(scratchpad, { action: "modify", id: "sp-old-1", content: "updated body v1" });
  check("modify reports success", typeof res === "string" && /updated/i.test(res), JSON.stringify(res));
  res = await call(scratchpad, { action: "read", id: "sp-old-1" });
  check(
    "modified note readable by original id",
    typeof res === "string" && res.includes("updated body v1"),
    JSON.stringify(res).slice(0, 300),
  );
  res = await call(scratchpad, { action: "modify", id: "sp-old-1", content: "updated body v2" });
  check(
    "second modify with same id succeeds",
    typeof res === "string" && /updated/i.test(res),
    JSON.stringify(res).slice(0, 300),
  );
  res = await call(scratchpad, { action: "list" });
  check(
    "id remains stable after modify",
    typeof res === "string" && res.includes("sp-old-1"),
    JSON.stringify(res).slice(0, 300),
  );

  section("scratchpad: delete non-existent must not corrupt");

  const beforeSpDelete = read(path.join(SCRATCH, "scratchpad.md"));
  res = await call(scratchpad, { action: "delete", id: "nope-xyz" });
  const afterSpDelete = read(path.join(SCRATCH, "scratchpad.md"));
  check(
    "scratchpad delete unknown id reports not-found",
    typeof res === "string" && /not found|no |could not/i.test(res),
    JSON.stringify(res).slice(0, 200),
  );
  check("scratchpad delete unknown id leaves file intact", beforeSpDelete === afterSpDelete, "");

  // ═════════════════════════════════════════════════════════════════════════
  section("backup: legacy root + target backups preserved on create");

  // Legacy backup living directly in BACKUP_DIR root, plus a two-days-old
  // backup in a target folder.
  write(path.join(BACKUPS, "2026-01-01-settings.md"), "old legacy settings backup");
  write(path.join(BACKUPS, "settings", "2026-01-01-settings.md"), "old settings backup");
  write(path.join(MEMORY, "settings.md"), read(path.join(MEMORY, "settings.md")));

  res = await call(backup, { action: "list" });
  check(
    "backup list shows backups",
    typeof res === "string" && res.includes("settings"),
    JSON.stringify(res).slice(0, 300),
  );

  res = await call(backup, { action: "create", target: "settings" });
  const settingsBackupsDir = path.join(BACKUPS, "settings");
  const remaining = fs.readdirSync(settingsBackupsDir);
  check(
    "create keeps at least the pre-existing backup",
    remaining.some((n) => n.endsWith("settings.md")),
    JSON.stringify(remaining),
  );
  check(
    "pre-restore / legacy backups listed after create",
    typeof (await call(backup, { action: "list" })) === "string" &&
      (await call(backup, { action: "list" })).includes("settings"),
    "",
  );

  section("backup: path traversal blocked");

  write(path.join(MEMORY, "goals.md"), "goals content that must not be overwritten");
  const goalsBefore = read(path.join(MEMORY, "goals.md"));
  res = await call(backup, {
    action: "restore",
    backup_file: "../../brain/memory/goals.md",
  });
  const goalsAfter = read(path.join(MEMORY, "goals.md"));
  check(
    "traversal reference rejected",
    typeof res === "string" && /error|not found|match expected/i.test(res),
    JSON.stringify(res).slice(0, 200),
  );
  check("traversal does not overwrite memory file", goalsBefore === goalsAfter, "");

  // ═════════════════════════════════════════════════════════════════════════
  console.log(`\n========================================`);
  console.log(`PASSED: ${passed}  FAILED: ${failed}`);
  if (failed > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("ALL TESTS PASSED");
}

main().catch((err) => {
  console.error("Test harness crashed:", err);
  process.exit(2);
});