import assert from "node:assert/strict";
import { createServer } from "node:https";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { generate } from "selfsigned";

const root = fileURLToPath(new URL("../", import.meta.url));

async function runChild(status: number): Promise<string> {
  const { private: key, cert: certificate } = await generate([{ name: "commonName", value: "localhost" }], {
    keySize: 2048,
    algorithm: "sha256",
    notBeforeDate: new Date(Date.now() - 60_000),
    notAfterDate: new Date(Date.now() + 60 * 60_000),
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] }
    ]
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "otg-active-listings-lifecycle-"));
  const server = createServer({ key, cert: certificate }, (_request, response) => { response.writeHead(status, { "content-type": "application/json" }); response.end(status === 200 ? JSON.stringify({ listings: [], next: null }) : JSON.stringify({ error: "local_failure" })); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const sourceUrl = pathToFileURL(path.join(root, "src", "activeListings.ts")).href;
  const childFile = path.join(directory, "child.mjs");
  await writeFile(childFile, `import { ActiveListingsClient, ACTIVE_LISTINGS_LOCAL_TEST_ENDPOINT } from ${JSON.stringify(sourceUrl)};\nconst client = new ActiveListingsClient({ apiKey: "local-test-only", retryPolicy: { maxRetries: 0 }, [ACTIVE_LISTINGS_LOCAL_TEST_ENDPOINT]: "https://127.0.0.1:${address.port}" });\ntry { await client.fetchSnapshot(); console.log("REQUEST_COMPLETED"); } finally { await client.close(); console.log("CLIENT_CLOSED"); }\nconsole.log("MAIN_RESOLVED");\n`, "utf8");
  const child = spawn(process.execPath, ["--import", "tsx", childFile], { cwd: root, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("child_exit_timeout")); }, 5_000);
      child.once("error", reject);
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    assert.equal(exit.code, 0, output);
    assert.equal(exit.signal, null, output);
    return output;
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("default node:https transport closes owned resources and child exits naturally on success", async () => {
  const output = await runChild(200);
  assert.match(output, /REQUEST_COMPLETED/);
  assert.match(output, /CLIENT_CLOSED/);
  assert.match(output, /MAIN_RESOLVED/);
});

test("default node:https transport closes owned resources and child exits naturally on local HTTP failure", async () => {
  const output = await runChild(500);
  assert.match(output, /REQUEST_COMPLETED/);
  assert.match(output, /CLIENT_CLOSED/);
  assert.match(output, /MAIN_RESOLVED/);
});
