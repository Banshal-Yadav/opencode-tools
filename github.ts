import { tool } from "@opencode-ai/plugin";
import https from "https";

export default tool({
  description: "Search GitHub profiles, list repositories, and read source code. No API key required.",
  args: {
    username: tool.schema.string().default("").describe("The GitHub username."),
    repo: tool.schema.string().optional().describe("Specific repository name (optional)."),
    path: tool.schema.string().optional().describe("File or directory path (used if repo is provided)."),
  },
  async execute(args) {
    return new Promise((resolve) => {
      const headers = { 'User-Agent': 'OpenCode-Agent/1.0' };

      const fetch = (path: string): Promise<any> => {
        return new Promise((resRel) => {
          const req = https.get({ hostname: 'api.github.com', path, headers }, (res) => {
            if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
              const nextUrl = new URL(res.headers.location);
              fetch(nextUrl.pathname + nextUrl.search).then(resRel);
              return;
            }
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => { try { resRel(JSON.parse(data)); } catch { resRel(null); } });
          });
          req.on('error', () => resRel(null));
        });
      };

      const run = async () => {
        // Mode: Read Code / Folder
        if (args.repo) {
          const path = args.path || "";
          const data: any = await fetch(`/repos/${args.username}/${args.repo}/contents/${path}`);
          
          if (Array.isArray(data)) {
            return resolve(`Directory ${args.username}/${args.repo}/${path}:\n` + data.map((f: any) => `- ${f.name} (${f.type})`).join('\n'));
          } else if (data?.content) {
            return resolve(Buffer.from(data.content, 'base64').toString('utf8'));
          }
          return resolve(`Repo or path not found: ${args.username}/${args.repo}/${path}`);
        }

        // Mode: User Profile + Repos
        const user: any = await fetch(`/users/${args.username}`);
        if (!user?.login) return resolve(`User "${args.username}" not found.`);
        
        const repos: any = await fetch(`/users/${args.username}/repos?sort=updated&per_page=15`);
        const repoList = Array.isArray(repos) ? repos.map((r: any) => `- ${r.name} [★${r.stargazers_count}]`).join('\n') : "No repos.";
        
        resolve(`User: ${user.name || user.login}\nBio: ${user.bio || 'N/A'}\n\nRepositories:\n${repoList}`);
      };

      run();
    });
  },
});
