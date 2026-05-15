# Agent Rules

## USER Context

- **SESSION START — MANDATORY FIRST ACTION:** At the start of EVERY session, run these steps in exact order before processing anything:
  1. **List current directory files** — `Get-ChildItem` (or `glob` / `list_dir`). Store silently. Do NOT print unless asked.
  2. **Read startup memory in ONE call** — `brain-memory` with `action=read-many`, `targets=about,settings`
  - **Lazy load the rest — only when relevant:**
     - `targets=goals` — when user mentions goals, deadlines, milestones, exams, or progress
     - `targets=projects` — when user mentions a project, codebase, or asks what's active
     - `targets=bookmark` — when user asks to save/find a link, idea, or resource
     - `targets=goals,projects` — combine when needed, still one call
  3. **Read scratchpad** — call `scratchpad` with `action=read`. If content exists, there is a pending handoff from last session — resume from it before doing anything else.
  - Conflict routing: milestone -> goals.md, preference -> settings.md, inactive idea -> bookmark.md, project lifecycle -> projects.md, identity/person -> about.md

- Do this BEFORE processing the user's message. No exceptions, even for simple greetings or one-word queries.
- Read memory silently. NEVER summarize, list, or mention what you found in memory unless the user explicitly asks. NEVER narrate your reasoning or rules out loud. Just respond naturally.
- NEVER suggest what to work on unless the user asks. Respond only to what they say.

- **Name:** [YOUR NAME]
- **GitHub:** [[YOUR_GITHUB_USERNAME]](https://github.com/[YOUR_GITHUB_USERNAME])
- **HuggingFace:** [[YOUR_HUGGINGFACE_USERNAME]](https://huggingface.co/[YOUR_HUGGINGFACE_USERNAME])
- **Primary Interests:** [YOUR INTERESTS] (e.g. DSA, MERN stack, AI/ML)

---

## AGENTS.md Hierarchy (CRITICAL — NO EXCEPTIONS)

### Two Levels of AGENTS.md
| Level | Location | Permission | Priority |
|-------|----------|------------|----------|
| **Global** | `os.homedir()/.config/opencode/AGENTS.md` | **READ ONLY — NEVER WRITE** | Lower |
| **Folder-level** | `<project-root>/AGENTS.md` or `<cwd>/AGENTS.md` | Read + Write allowed | **Higher — always wins** |

### Rules
- **Global AGENTS.md is READ ONLY.** Never edit, append, write, or touch it in any way — not via `edit`, `write`, `brain-memory`, shell commands, or any tool. If a task seems to require updating global AGENTS.md, STOP and ask the user.
- **Folder-level AGENTS.md always overrides global** for any conflicting instruction. If a project has its own AGENTS.md, treat it as the active ruleset for that session.
- If both exist → merge mentally, but folder-level wins on conflicts.
- If only global exists → follow global, read-only.
- **When in doubt which AGENTS.md to edit → ALWAYS edit folder-level, NEVER global.**

---

## Hardware Constraint
- **Finite hardware resources (e.g., VRAM). Context is a finite resource. Every token costs.**
- Prefer `grep` or `glob` over reading whole files — only `read` what you actually need.
- Never load more than 3 large files into context at once.

## Shell & OS
- OS: **Windows/Linux/MacOS**. Shell: **PowerShell/Bash**.
- Use appropriate shell commands for your OS.
- Always use relative paths or environment variables like `os.homedir()` or `$env:USERPROFILE` when in doubt.
- **Do NOT use `&&` to chain commands in PowerShell.** PowerShell uses `;` or `if ($?) { }`.

## Scale-Based Mode
1. Estimate scope by running `glob` to count files involved.
2. **≤ 4 files → Single Agent.** Write code yourself. No sub-agents.
3. **> 4 files → Orchestrator.** Use `todowrite` first. Delegate every chunk to sub-agents. Never write code yourself in this mode. Spawn as many agents as needed — no limit.

### Code Editing Rules (CRITICAL)
- **NEVER edit code files yourself if the task spans more than 4 files.** Always orchestrate.
- **Always break tasks into micro-tasks** — one agent, one file, one clear job. Never give an agent multiple files or a vague instruction.
- **Agent task size limit:** Each agent gets max 1–2 files and 1 clearly defined operation. If a job feels big, split it further.
- **Agents get stuck in loops on heavy tasks.** When in doubt, split more aggressively.
- **Spawning more agents is always better than overloading one.**

### Agent Honesty & Verification (CRITICAL)
- Every agent MUST honestly report what it did, what it changed, and what failed.
- If an agent encounters an error → it MUST report the exact error, not skip or silently retry.
- **After every agent completes** → orchestrator verifies by reading the output file or running a check. Never trust agent output blindly.
- If agent output is wrong or incomplete → rewrite the prompt and respawn. Do NOT rerun the same prompt.
- Agents CANNOT use the `scratchpad` tool. Scratchpad is orchestrator-only.

## Custom Tools Overview
| Tool | Platform | Default User | Capabilities |
|------|----------|--------------|--------------|
| `wikipedia` | Wikipedia | N/A | Search summaries for Concepts, Math, History, and Definitions. |
| `github` | GitHub | `[YOUR_GITHUB_USERNAME]` | Fetch profiles, list repositories, and read/analyze source code. |
| `huggingface` | HuggingFace | `[YOUR_HUGGINGFACE_USERNAME]` | Search models, datasets, and profiles on the HF Hub. |
| `log` | Global Brain | N/A | Record atomic tasks to daily logs, retrieve logs, list history, delete old files. |
| `brain-memory` | Global Brain | N/A | CRUD working notes inside `## 📝 Working Notes` of about/goals/settings/projects.md. |
| `scratchpad` | Global Brain | N/A | Dedicated tool for temporary notes and mid-session context. |
| `backup` | Global Brain | N/A | Backup/restore memory files before edits. Always call before touching memory files. |
| `brain-memory` (bookmark) | Global Brain | N/A | Save ideas, links, prompts, things to try for later reference. |
| `x-draft` | Local Brain | @[YOUR_Twitter_Handle] | Generate tweet/thread drafts from milestones. Saves to brain/drafts/. |

### Tool Selection Guide:
- **GitHub Tasks:** ALWAYS use the `github` tool. User: `[YOUR_GITHUB_USERNAME]`.
- **AI/ML/Models:** ALWAYS use the `huggingface` tool. User: `[YOUR_HUGGINGFACE_USERNAME]`.
- **Facts/Definitions:** ALWAYS use the `wikipedia` tool.
- **Log/History:** Use `log` for ALL daily tracking with actions (`write`, `read`, `list`, `entry-list`, `migrate`, `delete`). **DO NOT use `glob` or `list_dir` for history.**
- **Working Notes / Short-term context:** Use `brain-memory` with the correct `target` (about/goals/settings/projects).
- **Updating memory files:** ONLY via `brain-memory` tool. NEVER direct `edit` or `write`.
- **Reading memory files** (about/goals/settings/projects/bookmark): ALWAYS use `brain-memory` with `action=read`. NEVER use `read` tool or shell commands directly on memory files.
- **Reading drafts:** ALWAYS use `x-draft` with `action=read` or `action=list`. NEVER read draft files directly.
- **Reading bookmarks:** ALWAYS use `brain-memory` with `action=read`, `target=bookmark`. NEVER read bookmark.md directly.

## Memory File Rules (CRITICAL)

### The Five Memory Files
| File | Path | Purpose | Update Frequency |
|------|------|---------|-----------------|
| `about.md` | `brain/memory/about.md` | Identity, people, primary interests | Rarely — only if user explicitly updates identity context |
| `goals.md` | `brain/memory/goals.md` | Current focus, active goals, major milestones | After sessions, on goal changes |
| `settings.md` | `brain/memory/settings.md` | Preferences, tool rules, communication style, dev environment | When user shares new preferences |
| `projects.md` | `brain/memory/projects.md` | Active project paths, stack, status, archived projects | On project status/path/stack updates |
| `bookmark.md` | `brain/memory/bookmark.md` | Ideas, links, prompts, things to try, resources, tools to explore, inspiration | When user says "save this", "for later", "bookmark", "note this idea" |

### Dedup Rule
- Before appending any milestone to goals.md, read the Major Milestones section first. If same topic already exists for today's date, skip. Never append duplicates.
- NEVER use `brain-memory` Working Notes to log milestones or task completions. Milestones go to Major Milestones via `brain-memory` with `action=create`, `target=goals`. Working Notes are for mid-session thoughts and decisions only.

### Hard Rules for Memory Files (CRITICAL — NO EXCEPTIONS)
- **STEP 1 — ALWAYS call `backup` with `action=create` BEFORE any memory file update. No exceptions.**
- **STEP 2 — ONLY use `brain-memory` tool** to read or update memory files. NEVER use `edit`, `write`, shell commands, or direct file reads on memory files under any circumstance.
- `about.md` is near-static. Do NOT touch it unless the user explicitly says to update their profile/identity.
- If unsure which file to update → default to `settings.md` for preferences, `goals.md` for progress.
- `goals.md` is for goals, progress, and milestones only. Never write session details, tool outputs, or task summaries here — those go to log only.
- If a memory file gets corrupted or wiped → call `backup` with `action=restore` immediately.
- **The anti-loop fallback rule NEVER applies to memory files.** If `brain-memory` tool fails on a memory file, STOP immediately and tell the user what failed. Never fall back to direct `edit` or `write` on memory files under any circumstance, regardless of how many times the tool has failed.

### What Goes Where
- "I like X" / "I prefer X" / communication style / tool rules → `settings.md`
- Task completed / milestone reached → `goals.md` Major Milestones + `log`
- Goal status changed → `brain-memory` with `action=modify`, `target=goals`
- Identity info (GitHub, path, etc.) → `about.md` only if explicitly asked
- Project path / stack / status update → `projects.md`
- New project started → `projects.md` under Active Projects
- Project completed → move to Archived Projects in `projects.md`
- Mid-session thought / decision / context → `brain-memory` Working Notes (temporary)
- "save this" / "for later" / "bookmark" / "note this idea" → `bookmark.md`
- Useful link / resource / article / repo / video → `bookmark.md`
- Tool or library to explore later → `bookmark.md`
- Future project idea not yet active → `bookmark.md` (NOT `goals.md`)
- Good prompt / test case / experiment idea → `bookmark.md`
- Active goal / current sprint / ongoing project → `goals.md`
- Upcoming exam, deadline, event, or important date → `goals.md`
- Temporary behavior change due to life event ("exam mode", "pausing projects") → `settings.md`
- Anything that doesn't fit above → default to `settings.md` for preferences, `bookmark.md` for ideas
- Milestone posted on X → call `x-draft` with `action=mark-posted`

---

## Log & Memory Pipelines

### Log Deletion Safety (CRITICAL)
- **NEVER self-generate confirmTokens.** For `scope=day` deletions, always stop and ask the user: "Confirm deletion of [date] log? Reply with: DELETE-DAY-YYYY-MM-DD to proceed." Only call delete after the user provides the token in their own message.
- **Always call `backup` with `action=create` before any log deletion**, whether scope=entry or scope=day.

### Log Tool Pipeline (`tools/log.ts`)
- **Purpose:** Daily activity journal under `brain/logs/YYYY-MM-DD.md`. Each day is a separate file.
- **When to READ log:** ONLY when user explicitly asks — e.g. "what did we do yesterday?", "what happened last week?", "search my history for X". Do NOT read log on session start or proactively.
- **When to WRITE log:** After every meaningful action this session (silently, no announcement).
- **Constraint:** ALWAYS keep logs concise. Single line preferred, max 2 sentences. Focus on action + outcome.
- **Default:** `action=write` appends a timestamped line to today's log.
- **Safe deletion:** `action=delete` defaults to `scope=entry`. Full-day needs `scope=day` + `date` + `confirmToken`.
- **Dry-run:** Use `dryRun=true` to preview before destructive actions.

**Actions:**
- `write`: Record task updates and milestones.
- `read`: Open one day's log.
- `list`: View available day files.
- `entry-list`: View all entries for a date with IDs.
- `migrate`: Backfill IDs for legacy log lines.
- `delete` + `scope=entry`: Remove one entry (by `id`, or latest if no `id`).
- `delete` + `scope=day`: Remove full day file (needs `date` + `confirmToken` from user).

**Short Examples:**
- Write: `{"action":"write","content":"Finished API retry fix"}`
- Entry list: `{"action":"entry-list","date":"2026-04-23"}`
- Delete entry: `{"action":"delete","scope":"entry","date":"2026-04-23"}`
- Delete day: `{"action":"delete","scope":"day","date":"2026-04-23","confirmToken":"DELETE-DAY-2026-04-23"}`

### Brain Memory Pipeline (`tools/brain-memory.ts`)
- **Purpose:** Timestamped working notes inside `## 📝 Working Notes` of each memory file.
- **Targets:** `settings` (default), `goals`, `about`, `projects`, `bookmark`.
- **Storage:** Directly inside the target `.md` file — NOT separate dated files.
- **`action=auto`:** Creates if content provided, reads otherwise.

**CRUD:**
- `create`: Append timestamped note with ID to Working Notes.
- `read`: All notes, or filter by `date` or `id`.
- `modify`: Update one entry by ID.
- `delete`: Delete one entry by ID.
- `list`: List all entries with preview.

**Short Examples:**
- Auto-create in settings: `{"action":"auto","content":"Remember to benchmark v2 tokenizer"}`
- Create in goals: `{"action":"create","target":"goals","content":"Decided to skip Trees until Arrays done"}`
- Read all settings notes: `{"action":"read","target":"settings"}`
- Delete: `{"action":"delete","target":"settings","id":"2026-04-23-..."}`

### Trigger Rules (Clear Contract)
