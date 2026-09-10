import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = new URL("..", import.meta.url).pathname.replace(/^\//, "").replaceAll("/", "\\");
const source = join(root, "tests");
const output = join(root, ".codex-test-tmp", "tests");
async function walk(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) result.push(full);
  }
  return result.sort();
}
const files = await walk(source);
for (const file of files) {
  const relative = file.slice(source.length + 1).replace(/\.ts$/i, ".js");
  const target = join(output, relative);
  const input = await readFile(file, "utf8");
  const transpiled = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, esModuleInterop: true, sourceMap: false }, fileName: file });
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, transpiled.outputText.replace(/(\bfrom\s+["'][^"']+)\.ts(["'])/g, "$1.js$2").replace(/(\bimport\(["'][^"']+)\.ts(["']\))/g, "$1.js$2"), "utf8");
}
async function walkScripts(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walkScripts(full));
    else if (entry.isFile() && full.endsWith(".ts")) result.push(full);
  }
  return result;
}
await cp(join(root, "tests", "fixtures"), join(root, ".codex-test-tmp", "tests", "fixtures"), { recursive: true, force: true }).catch(() => {});
await cp(join(root, "sql"), join(root, ".codex-test-tmp", "sql"), { recursive: true, force: true }).catch(() => {});
await cp(join(root, "src"), join(root, ".codex-test-tmp", "src"), { recursive: true, force: true });
await cp(join(root, "scripts"), join(root, ".codex-test-tmp", "scripts"), { recursive: true, force: true });
await cp(join(root, "package.json"), join(root, ".codex-test-tmp", "package.json"), { force: true });
for (const file of await walkScripts(join(root, "scripts"))) {
  const relative = file.slice(join(root, "scripts").length + 1).replace(/\.ts$/i, ".js");
  const target = join(root, ".codex-test-tmp", "scripts", relative);
  const input = await readFile(file, "utf8");
  const transpiled = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, esModuleInterop: true }, fileName: file });
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, transpiled.outputText.replace(/\.ts(["'])/g, ".js$1"), "utf8");
}
console.log(`COMPILED_TEST_FILES=${files.length}`);
