// Build + run the verification suite. Compiles the tools (+ tests) to
// .verify/out with tsc, then executes the compiled ESM tests with node.
import { execSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";

const run = (cmd) => execSync(cmd, { stdio: "inherit", shell: "powershell.exe" });

if (existsSync(".verify/out")) rmSync(".verify/out", { recursive: true, force: true });

run("npx tsc -p tsconfig.build.json");
// Mark the compiled output as ESM so node runs the tool modules as modules.
writeFileSync(".verify/out/package.json", JSON.stringify({ type: "module" }));
run("node .verify/out/verify/tests.js");