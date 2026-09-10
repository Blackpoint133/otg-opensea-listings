import { readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.env.CODEX_HERMETIC_TESTS = "1";
const output = join(root, ".codex-test-tmp");
const sourceDir = join(root, "tests");
const compiler = join(root, "node_modules", "typescript", "bin", "tsc");
const run = (command, args) => new Promise((resolveRun) => {
  let settled = false;
  const finish = (code) => { if (!settled) { settled = true; resolveRun(code); } };
  const child = spawn(process.execPath, [command, ...args], { cwd: root, stdio: "inherit", windowsHide: true });
  child.once("error", () => finish(1));
  child.once("close", (code, signal) => finish(signal ? 1 : (code ?? 1)));
});
async function testSources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await testSources(full));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) found.push(full);
  }
  return found.sort();
}
let exitCode = 1;
try {
  await rm(output, { recursive: true, force: true });
  if (!existsSync(compiler)) throw new Error("TYPESCRIPT_COMPILER_MISSING");
  const sources = await testSources(sourceDir);
  if (sources.length === 0) throw new Error("NO_SOURCE_TESTS");
  const compileCode = await run(compiler, ["-p", "tsconfig.hermetic.json"]);
  if (compileCode !== 0) { exitCode = compileCode; }
  else {
    const testCompileCode = await run("scripts/compileHermeticTests.mjs", []);
    if (testCompileCode !== 0) throw new Error("TEST_COMPILE_FAILED");
    const compiled = sources.map((file) => join(output, "tests", file.slice(sourceDir.length + 1).replace(/\.ts$/i, ".js")));
    if (compiled.some((file) => !existsSync(file)) || compiled.length !== sources.length) throw new Error("TEST_PARITY_MISMATCH");
    exitCode = await run("--test", compiled);
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); exitCode = 1; }
finally { await rm(output, { recursive: true, force: true }); }
process.exitCode = exitCode;
