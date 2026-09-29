# OpenCode Agent Instructions

## Session Startup

Execute these actions in order at session start:
1. List workspace directory silently.
2. Read startup memory in one call: `brain-memory` with `action=read-many`, `targets=about,settings`.
3. Check scratchpad: `scratchpad` with `action=read`. Resume any pending handoff context.
4. Lazy load additional memory targets only when relevant:
   - `goals`: active deadlines, milestones, exam schedules, or progress.
   - `projects`: project paths, stack details, or active codebases.
   - `bookmark`: saving/retrieving links, ideas, prompts, or resources.

Do not summarize or mention memory contents unless requested. Respond naturally to the user prompt.

---

## Tool Reference

| Tool | Scope / Path | Key Actions & Capabilities |
|---|---|---|
| `brain-memory` | `~/.config/opencode/brain/memory/` | Read/write working notes in `about`, `goals`, `settings`, `projects`, `bookmark`. |
| `scratchpad` | `~/.config/opencode/brain/scratch/` | Temporary session notes, checkpoints, and raw context dumps. |
| `log` | `~/.config/opencode/brain/logs/` | Write, read, list, and filter daily task logs (`YYYY-MM-DD.md`). |
| `backup` | `~/.config/opencode/brain/backups/` | Automated and manual backups of memory files and drafts. |
| `github` | GitHub API | Repository details, profile summary, issue listing, file inspection. |
| `huggingface` | HuggingFace API | Model/dataset search, user profile queries, model metadata. |
| `wikipedia` | Wikipedia API | Article summaries, search queries, definition lookup. |
| `x-draft` | `~/.config/opencode/brain/drafts/` | Draft X posts/threads, local LM Studio integration, post tracking. |
| `music-player` | `~/.config/opencode/brain/music/` | Terminal media playback (mpv backend), YouTube download (yt-dlp), playlist management. |

---

## Memory File Guidelines

- `about.md`: Identity, interests, background context. Touch only when explicitly requested.
- `goals.md`: Active goals, major milestones, progress, exam schedules.
- `settings.md`: Preferences, tool rules, communication style, environment configs.
- `projects.md`: Active/archived project paths, technical stacks, project status.
- `bookmark.md`: Links, ideas, prompts, tool inspiration, future un-started concepts.

### Memory & Log Safety Rules

1. Always call `backup` with `action=create` before modifying any memory file.
2. Access memory files strictly through the `brain-memory` tool. Direct file edits (`write_file`, `edit_file`) are prohibited.
3. If a memory operation fails, report the error. Never fall back to editing memory files directly.
4. Deduplicate milestones before appending to `goals.md`.
5. Require explicit confirmation before deleting daily log files (`scope=day`).

---

## Task Execution & Subagent Delegation

1. **Small Tasks (≤ 4 files):** Execute directly within the primary agent session.
2. **Large Tasks (> 4 files):** Orchestrate using micro-tasks. Break work into single-file or single-operation subagent prompts.
3. Subagents must operate with isolated, fully self-contained context instructions.
