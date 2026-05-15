import { tool } from "@opencode-ai/plugin";
import https from "https";

export default tool({
  description: "Search HuggingFace Hub. Defaults to ''.",
  args: {
    username: tool.schema.string().default("").describe("HuggingFace username."),
    limit: tool.schema.number().optional().default(10).describe("Result limit."),
  },
  async execute(args) {
    return new Promise((resolve) => {
      const headers = { 'User-Agent': 'OpenCode-Agent/1.0' };
      const user = args.username;

      const fetch = (url: string): Promise<any> => {
        return new Promise((resRel) => {
          https.get(url, { headers }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => { try { resRel(JSON.parse(data)); } catch { resRel(null); } });
          }).on('error', () => resRel(null));
        });
      };

      const run = async () => {
        // Try to fetch models by this author directly (most reliable way to confirm user)
        const models = await fetch(`https://huggingface.co/api/models?author=${user}&limit=${args.limit}`);
        const datasets = await fetch(`https://huggingface.co/api/datasets?author=${user}&limit=${args.limit}`);

        let output = `## HuggingFace Activity: ${user}\n`;
        let found = false;

        if (Array.isArray(models) && models.length > 0) {
            found = true;
            output += `\n**Models:**\n` + models.map((m: any) => `- ${m.id} [★${m.likes || 0}]`).join('\n');
        }

        if (Array.isArray(datasets) && datasets.length > 0) {
            found = true;
            output += `\n**Datasets:**\n` + datasets.map((d: any) => `- ${d.id} [★${d.likes || 0}]`).join('\n');
        }

        if (!found) {
            // Final attempt: Search for the user string in the global search
            const search = await fetch(`https://huggingface.co/api/models?search=${user}&limit=1`);
            if (Array.isArray(search) && search.length > 0) {
                resolve(`User "${user}" might exist but has no public models/datasets. URL: https://huggingface.co/${user}`);
                return;
            }
            resolve(`HuggingFace user "${user}" not found or has no public activity.`);
            return;
        }

        output += `\n\nURL: https://huggingface.co/${user}`;
        resolve(output);
      };

      run();
    });
  },
});
