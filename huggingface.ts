import { tool } from "@opencode-ai/plugin";
import https from "https";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;

type HfResponse = { status: number; data: any; error?: string };

// Request helper that surfaces status/errors instead of collapsing everything
// to `null` (so a timeout is not reported as "no results").
function hfRequest(url: string, timeoutMs = 15000): Promise<HfResponse> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { "User-Agent": "OpenCode-Agent/1.0" };
    const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const req = https.get(url, { headers }, (res) => {
      const status = res.statusCode ?? 0;
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

    req.setTimeout(timeoutMs, () => req.destroy(new Error("request timed out")));
    req.on("error", (err) => resolve({ status: 0, data: null, error: err.message }));
  });
}

export default tool({
  description:
    "Search HuggingFace Hub for a user's models and datasets. Requires a username (set HF_TOKEN for higher rate limits).",
  args: {
    username: tool.schema.string().default("").describe("HuggingFace username."),
    limit: tool.schema.number().optional().default(DEFAULT_LIMIT).describe("Result limit (1-100)."),
  },
  async execute(args) {
    const user = (args.username ?? "").trim();
    if (!user) {
      return "Error: username is required. Provide a HuggingFace username to search.";
    }

    const requested = Number(args.limit ?? DEFAULT_LIMIT);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_LIMIT));
    const author = encodeURIComponent(user);

    // Independent requests — run them concurrently.
    const [modelsRes, datasetsRes] = await Promise.all([
      hfRequest(`https://huggingface.co/api/models?author=${author}&limit=${limit}`),
      hfRequest(`https://huggingface.co/api/datasets?author=${author}&limit=${limit}`),
    ]);

    const models = Array.isArray(modelsRes.data) ? modelsRes.data : null;
    const datasets = Array.isArray(datasetsRes.data) ? datasetsRes.data : null;

    // Both calls failed at the transport level → report the error, do not
    // pretend the user simply has no activity.
    if (models === null && datasets === null) {
      const err = modelsRes.error ?? datasetsRes.error ?? `HTTP ${modelsRes.status}/${datasetsRes.status}`;
      return `HuggingFace request failed: ${err}`;
    }

    let output = `## HuggingFace Activity: ${user}\n`;
    let found = false;

    if (models && models.length > 0) {
      found = true;
      output += `\n**Models:**\n` + models.map((m: any) => `- ${m.id} [★${m.likes || 0}]`).join("\n");
    }

    if (datasets && datasets.length > 0) {
      found = true;
      output += `\n**Datasets:**\n` + datasets.map((d: any) => `- ${d.id} [★${d.likes || 0}]`).join("\n");
    }

    if (!found) {
      // Confirm the account exists via the dedicated users endpoint rather than
      // matching the raw string against model search results.
      const userRes = await hfRequest(`https://huggingface.co/api/users/${author}`);
      if (userRes.status === 200 && userRes.data) {
        return `User "${user}" exists but has no public models/datasets. URL: https://huggingface.co/${user}`;
      }
      return `HuggingFace user "${user}" not found or has no public activity.`;
    }

    output += `\n\nURL: https://huggingface.co/${user}`;
    return output;
  },
});