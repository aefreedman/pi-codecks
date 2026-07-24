import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";

const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(npmCommand, npmCli ? [npmCli, ...args] : args, { cwd: process.cwd(), stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`npm ${args.join(" ")} failed${signal ? ` (${signal})` : ` with exit code ${code}`}`));
    });
  });
}

try {
  // Unit tests import the extension directly, unlike Pi's loader. Install its
  // bundled schema dependency only for this test process and remove it below.
  await run(["install", "--no-save", "--package-lock=false", "--ignore-scripts", "typebox@^1.1.34"]);
  await run(["run", "test:unit"]);
  await run(["run", "test:integration"]);
} finally {
  await rm("node_modules", { recursive: true, force: true });
}
