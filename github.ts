import { tool } from "@opencode-ai/plugin";
import https from "https";

const API_HOST = "api.github.com";
const MAX_FILE_CHARS = 60000;

type GhResponse = {
  status: number;
  data: any;
  error?: string;
};

// Single low-level request with proper headers, timeout, redirect + error
// signalling. Never collapses a real failure into a silent `null` — the status
// and error surface to the caller so 403 rate-limits are not reported as 404s.
function ghRequest(path: string): Promise<GhResponse> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      "User-Agent": "OpenCode-Agent/1.0",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const req = https.get({ hostname: API_HOST, path, headers }, (res) => {
      const status = res.statusCode ?? 0;

      if (
        (status === 301 || status === 302 || status === 307 || status === 308) &&
        res.headers.location
      ) {
        res.resume();
        let next: URL;
        try {
          next = new URL(res.headers.location, `https://${API_HOST}`);
        } catch {
          resolve({ status, data: null, error: "Invalid redirect location." });
          return;
        }
        ghRequest(next.pathname + next.search).then(resolve);
        return;
      }

      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        let parsed: any = null;
        try {
          parsed = body ? JSON.parse(body) : null;
        } catch {
          parsed = null;
        }
        resolve({ status, data: parsed });
      });
      res.on("error", (err) => resolve({ status, data: null, error: err.message }));
    });

    req.setTimeout(15000, () => req.destroy(new Error("request timed out")));
    req.on("error", (err) => resolve({ status: 0, data: null, error: err.message }));
  });
}

// Encode each path segment but keep the slashes so `src/index.ts` stays a path.
function encodePathSegments(p: string): string {
  return p
    .split("/")
    .filter((seg) => seg.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

// Turn a non-OK GitHub response into an accurate, actionable message.
function describeFailure(res: GhResponse, notFoundMessage: string): string {
  if (res.status === 0) {
    return `GitHub request failed: ${res.error ?? "network error"}.`;
  }
  const message: string | undefined = res.data?.message;
  if (res.status === 403 && /rate limit/i.test(message ?? "")) {
    return `GitHub API rate limit exceeded. Set GITHUB_TOKEN to raise the limit. (${message ?? "403"})`;
  }
  if (res.status === 401) {
    return "GitHub authentication failed — check GITHUB_TOKEN.";
  }
  if (res.status === 404) {
    return notFoundMessage;
  }
  if (message) {
    return `GitHub API error ${res.status}: ${message}`;
  }
  return `GitHub API error ${res.status}.`;
}

export default tool({
  description:
    "Search GitHub profiles, list repositories, and read source code. No API key required (set GITHUB_TOKEN for higher rate limits).",
  args: {
    username: tool.schema.string().default("").describe("The GitHub username."),
    repo: tool.schema.string().optional().describe("Specific repository name (optional)."),
    path: tool.schema.string().optional().describe("File or directory path (used if repo is provided)."),
  },
  async execute(args) {
    const username = (args.username ?? "").trim();
    if (!username) {
      return "Error: username is required.";
    }

    // ── Mode: read code / list folder ────────────────────────────────────────
    if (args.repo) {
      const repo = args.repo.trim();
      if (!repo) return "Error: repo must not be blank.";

      const relPath = (args.path ?? "").replace(/^\/+/, "");
      const encodedPath = encodePathSegments(relPath);
      const endpoint = `/repos/${encodeURIComponent(username)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
      const res = await ghRequest(endpoint);
      const notFound = `Repo or path not found: ${username}/${repo}/${relPath}`;

      if (res.status !== 200) {
        // GitHub returns 404 for both missing repos and missing paths; empty
        // directories are reported via a 200 with an array.
        const hint =
          res.status === 404
            ? `${notFound}. (Note: GitHub returns 404 for empty directories too.)`
            : describeFailure(res, notFound);
        return hint;
      }

      const data = res.data;

      if (Array.isArray(data)) {
        if (data.length === 0) {
          return `Directory ${username}/${repo}/${relPath || "/"} is empty.`;
        }
        return (
          `Directory ${username}/${repo}/${relPath}:\n` +
          data.map((f: any) => `- ${f.name} (${f.type})`).join("\n")
        );
      }

      // Large files (>1MB) return encoding:"none" with no inline content.
      if (data && (data.encoding === "none" || (!data.content && data.download_url))) {
        return (
          `File ${relPath} is too large for the GitHub contents API (encoding: none). ` +
          `Fetch it directly: ${data.download_url ?? "use the git blob API"}`
        );
      }

      if (data?.content) {
        const decoded = Buffer.from(
          data.content,
          data.encoding === "base64" ? "base64" : "utf8",
        ).toString("utf8");
        if (decoded.length > MAX_FILE_CHARS) {
          return (
            decoded.slice(0, MAX_FILE_CHARS) +
            `\n\n...(truncated, ${decoded.length - MAX_FILE_CHARS} more characters. Read a subpath or use raw download.)`
          );
        }
        return decoded;
      }

      return notFound;
    }

    // ── Mode: user profile + repos ───────────────────────────────────────────
    const userRes = await ghRequest(`/users/${encodeURIComponent(username)}`);
    const user = userRes.data;
    if (userRes.status !== 200 || !user?.login) {
      return describeFailure(userRes, `User "${username}" not found.`);
    }

    const reposRes = await ghRequest(
      `/users/${encodeURIComponent(username)}/repos?sort=updated&per_page=30`,
    );
    const repos = reposRes.data;
    const repoList =
      Array.isArray(repos) && repos.length > 0
        ? repos.map((r: any) => `- ${r.name} [★${r.stargazers_count}]`).join("\n")
        : Array.isArray(repos)
          ? "No public repos."
          : "Could not load repos.";

    const header =
      Array.isArray(repos) && repos.length === 30 ? "\n\n(showing up to 30 most recently updated)" : "";
    return `User: ${user.name || user.login}\nBio: ${user.bio || "N/A"}\n\nRepositories:\n${repoList}${header}`;
  },
});