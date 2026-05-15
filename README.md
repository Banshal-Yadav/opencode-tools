# OpenCode Tools

Custom tools that give your OpenCode agent persistent memory, logging, and real-world integrations.

A modular suite of AI-powered developer tools designed for the OpenCode agent. This repository provides a "Global Brain" for your local agent, enabling long-term memory, automated logging, and seamless integration with GitHub, Hugging Face, and Wikipedia.

## 🧠 Core Philosophy
These tools turn a stateless AI into a persistent collaborator by maintaining a structured "Brain" in your local config directory.

##  Setup Instructions

### 1. Prerequisites
- **OpenCode Plugin System:** Ensure you have the `@opencode-ai/plugin` framework installed.
- **Node.js:** Tools are written in TypeScript/JavaScript.
- **Local Directory:** These tools expect a configuration folder at `~/.config/opencode/`.

### 2. Folder Structure
```text
~/.config/opencode/
├── AGENTS.md            <-- Copy AGENTS.template.md here
├── brain/
│   ├── memory/          <-- Permanent .md files (about.md, goals.md, projects.md)
│   ├── logs/            <-- Daily timestamped logs
│   ├── drafts/          <-- X/Social media drafts
│   └── backups/         <-- Automated safety snapshots
```

### 3. Tool Configuration
Copy the provided `.ts` files into your OpenCode tools directory.

#### Personalized Customization
- `github.ts`: Add your GitHub username to the `default` schema value.
- `huggingface.ts`: Add your HF username to the `default` schema value.

### 4. Agent Rules (The OS)
1. Copy `AGENTS.template.md` to `~/.config/opencode/AGENTS.md`.
2. Replace placeholders like `[YOUR NAME]` and `[YOUR_GITHUB_USERNAME]` with your actual information.
3. This file tells the AI exactly *when* and *how* to use the memory and backup tools.

---

## 🛠️ Tool Overview

| Tool | Capability |
| :--- | :--- |
| **backup** | Creates safety snapshots of your memory before any edit. |
| **brain-memory** | Manages your persistent memory files with atomic working notes. |
| **scratchpad** | Temporary notepad for the agent to think out loud and store ideas. |
| **log** | Keeps a daily journal of every task and milestone achieved. |
| **github** | Fetches repos and reads code directly from GitHub. |
| **huggingface** | Explores models and datasets on the HF Hub. |
| **wikipedia** | Quick factual lookups for concepts and history. |
| **x-draft** | Drafts dev-tweets and threads from your work. |

## 🛡️ Privacy & Security
- **Local First:** All memory, logs, and drafts are stored locally as plain `.md` files.
- **No Cloud Required:** None of your personal data leaves your machine.

## 🤝 Contributing
Have a tool you've built for OpenCode? PRs welcome. Submit your `.ts` tool file with a brief description and it'll be added to the suite.

---

Read the origin story: [Twitter thread](https://x.com/Banshal_Yadav/status/2049173129591755232?s=20)

Built by the community, for the community.