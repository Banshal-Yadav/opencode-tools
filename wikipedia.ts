import { tool } from "@opencode-ai/plugin";
import https from "https";

const HOST = "en.wikipedia.org";
const MAX_CHARS = 60000;

type WikiResponse = { status: number; body: string; retryAfter?: string };

// Low-level request. Rejects only on transport failure/timeout; returns the
// status + body for non-200s so callers can distinguish 404 from 429.
function get(path: string, timeoutMs = 10000): Promise<WikiResponse> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: HOST,
        path,
        headers: {
          "User-Agent": "opencode-wikipedia-tool/1.0 (local dev tool)",
          Accept: "application/json",
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            retryAfter: res.headers["retry-after"] as string | undefined,
          }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Timeout")));
    req.on("error", reject);
  });
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Fetch the (full, if requested) plain-text extract for a title via the
// MediaWiki action API — used for the fullArticle path and as a fallback when
// the REST summary endpoint 404s.
async function fetchExtract(title: string, fullArticle: boolean): Promise<string | null> {
  const intro = fullArticle ? "" : "&exintro=1";
  const path = `/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&redirects=1${intro}&format=json&titles=${encodeURIComponent(title)}`;
  const res = await get(path);
  if (res.status !== 200) return null;
  const json = parseJson(res.body);
  const pages = json?.query?.pages;
  if (!pages) return null;
  const page: any = Object.values(pages)[0];
  if (!page || page.missing !== undefined || typeof page.extract !== "string") return null;
  return page.extract;
}

export default tool({
  description:
    "Search Wikipedia and get article summaries. Great for concepts, algorithms, data structures, history, science, and general knowledge. No API key required.",
  args: {
    query: tool.schema.string().describe("The topic to search for on Wikipedia."),
    fullArticle: tool.schema
      .boolean()
      .default(false)
      .describe("If true, returns the full article text (more detail). Default is the short intro summary."),
  },
  async execute(args) {
    const query = (args.query ?? "").trim();
    if (!query) {
      return "Error: query is required.";
    }
    const fullArticle = args.fullArticle === true;
    const q = encodeURIComponent(query);

    try {
      // Step 1: search for matching articles.
      const searchPath = `/w/api.php?action=query&list=search&srsearch=${q}&format=json&srlimit=3`;
      const searchRes = await get(searchPath);
      if (searchRes.status === 429) {
        return `Wikipedia rate limited. Retry after ${searchRes.retryAfter ?? "a few"} seconds.`;
      }
      if (searchRes.status !== 200) {
        return `Wikipedia Error: HTTP ${searchRes.status}`;
      }
      const searchJson = parseJson(searchRes.body);
      const hits: any[] = searchJson?.query?.search ?? [];

      if (hits.length === 0) {
        return `No Wikipedia articles found for "${query}".`;
      }

      const topTitle = hits[0].title as string;

      // Step 2: prefer the REST summary; fall back to the action API extract if
      // the summary endpoint 404s for this title.
      let title = topTitle;
      let description = "";
      let extract: string | null = null;
      let pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(topTitle)}`;

      const summaryRes = await get(`/api/rest_v1/page/summary/${encodeURIComponent(topTitle)}`);
      const summary = summaryRes.status === 200 ? parseJson(summaryRes.body) : null;

      if (summary) {
        title = summary.title ?? topTitle;
        description = summary.description ?? "";
        extract = summary.extract ?? "";
        pageUrl = summary.content_urls?.desktop?.page ?? pageUrl;
      } else if (summaryRes.status === 429) {
        return `Wikipedia rate limited. Retry after ${summaryRes.retryAfter ?? "a few"} seconds.`;
      } else {
        // Fallback for titles where the summary REST endpoint is unavailable.
        extract = await fetchExtract(topTitle, fullArticle);
        if (extract === null) {
          return `Found "${topTitle}" but could not load its summary (HTTP ${summaryRes.status}).`;
        }
      }

      // fullArticle: fetch the complete plain-text extract (capped).
      if (fullArticle) {
        const full = await fetchExtract(title, true);
        if (full) extract = full;
      }

      const lines: string[] = [];
      lines.push(`## ${title}`);
      if (description) lines.push(`*${description}*`);
      lines.push("");
      let body = extract && extract.length > 0 ? extract : "No summary available.";
      if (body.length > MAX_CHARS) {
        body = body.slice(0, MAX_CHARS) + `\n\n...(truncated, ${body.length - MAX_CHARS} more characters)`;
      }
      lines.push(body);
      lines.push("");
      lines.push(`🔗 ${pageUrl}`);

      if (hits.length > 1) {
        lines.push("");
        lines.push("**Related articles:**");
        for (const hit of hits.slice(1)) {
          lines.push(`- ${hit.title}: https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title)}`);
        }
      }

      return lines.join("\n");
    } catch (e: any) {
      return `Wikipedia Error: ${e?.message ?? String(e)}`;
    }
  },
});