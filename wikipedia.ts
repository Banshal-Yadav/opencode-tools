import { tool } from "@opencode-ai/plugin";
import https from "https";

function get(hostname: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname,
        path,
        headers: {
          "User-Agent": "opencode-wikipedia-tool/1.0 (local dev tool)",
          "Accept": "application/json",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      }
    );
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.on("error", reject);
  });
}

export default tool({
  description:
    "Search Wikipedia and get article summaries. Great for concepts, algorithms, data structures, history, science, and general knowledge. No API key required.",
  args: {
    query: tool.schema.string().describe("The topic to search for on Wikipedia."),
    fullArticle: tool.schema
      .boolean()
      .default(false)
      .describe("If true, returns the full article intro (more detail). Default is a short summary."),
  },
  async execute(args) {
    const q = encodeURIComponent(args.query);

    try {
        // Step 1: Search for matching articles
        const searchPath = `/w/api.php?action=query&list=search&srsearch=${q}&format=json&srlimit=3`;
        const searchRaw = await get("en.wikipedia.org", searchPath);
        const searchJson = JSON.parse(searchRaw);
        const hits: any[] = searchJson?.query?.search ?? [];

        if (hits.length === 0) {
          return `No Wikipedia articles found for "${args.query}".`;
        }

        const topTitle = hits[0].title;
        const encodedTitle = encodeURIComponent(topTitle);

        // Step 2: Get summary via REST API
        const summaryPath = `/api/rest_v1/page/summary/${encodedTitle}`;
        const summaryRaw = await get("en.wikipedia.org", summaryPath);
        const summary = JSON.parse(summaryRaw);

        const lines: string[] = [];

        lines.push(`## ${summary.title}`);
        if (summary.description) lines.push(`*${summary.description}*`);
        lines.push("");
        lines.push(summary.extract ?? "No summary available.");
        lines.push("");
        lines.push(`🔗 ${summary.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodedTitle}`}`);

        // Show other search hits as related articles
        if (hits.length > 1) {
          lines.push("");
          lines.push("**Related articles:**");
          for (const hit of hits.slice(1)) {
            lines.push(`- ${hit.title}: https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title)}`);
          }
        }

        return lines.join("\n");
    } catch (e: any) {
        return `Wikipedia Error: ${e.message}`;
    }
  },
});
