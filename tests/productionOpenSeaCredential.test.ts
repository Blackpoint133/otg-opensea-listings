import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveProjectEnvPath } from "../src/config/projectEnv.js";
import { loadCanonicalProductionOpenSeaApiKey, PRODUCTION_OPENSEA_API_KEY_SOURCE_CONFLICT } from "../src/runtime/productionOpenSeaCredential.js";
import { ProductionIngestionRuntime } from "../src/runtime/productionIngestionRuntime.js";

async function fakeFile(contents: string): Promise<{ path: string; read: (requested: string, encoding: "utf8") => string; close: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "otg-credential-test-"));
  const filePath = path.join(directory, ".env");
  await writeFile(filePath, contents, "utf8");
  return { path: filePath, read: (_requested, encoding) => fs.readFileSync(filePath, encoding), close: () => rm(directory, { recursive: true, force: true }) };
}

test("canonical file value is authoritative when ambient value is absent", async () => {
  const file = await fakeFile("OPENSEA_API_KEY=  canonical-test-value  \n");
  try { assert.equal(loadCanonicalProductionOpenSeaApiKey({ readFileSync: file.read, ambientValue: undefined }), "canonical-test-value"); } finally { await file.close(); }
});

test("identical ambient value does not override the canonical file", async () => {
  const file = await fakeFile("OPENSEA_API_KEY=canonical-test-value\n");
  try { assert.equal(loadCanonicalProductionOpenSeaApiKey({ readFileSync: file.read, ambientValue: " canonical-test-value " }), "canonical-test-value"); } finally { await file.close(); }
});

test("different ambient value fails with the fixed source-conflict error", async () => {
  const file = await fakeFile("OPENSEA_API_KEY=canonical-test-value\n");
  try {
    assert.throws(() => loadCanonicalProductionOpenSeaApiKey({ readFileSync: file.read, ambientValue: "inherited-value" }), (error: unknown) => error instanceof Error && error.message === PRODUCTION_OPENSEA_API_KEY_SOURCE_CONFLICT);
  } finally { await file.close(); }
});

test("missing, empty, and duplicate canonical assignments fail closed", async () => {
  const missing = await fakeFile("OTHER=value\n");
  const empty = await fakeFile("OPENSEA_API_KEY=   \n");
  const duplicate = await fakeFile("OPENSEA_API_KEY=one\nOPENSEA_API_KEY=two\n");
  try {
    assert.throws(() => loadCanonicalProductionOpenSeaApiKey({ readFileSync: () => { throw new Error("ENOENT"); }, ambientValue: undefined }), /PRODUCTION_OPENSEA_API_KEY_FILE_MISSING/);
    assert.throws(() => loadCanonicalProductionOpenSeaApiKey({ readFileSync: missing.read, ambientValue: undefined }), /OPENSEA_API_KEY_MISSING/);
    assert.throws(() => loadCanonicalProductionOpenSeaApiKey({ readFileSync: empty.read, ambientValue: undefined }), /OPENSEA_API_KEY_MISSING/);
    assert.throws(() => loadCanonicalProductionOpenSeaApiKey({ readFileSync: duplicate.read, ambientValue: undefined }), /DUPLICATE_CANONICAL_KEY_ASSIGNMENTS/);
  } finally { await Promise.all([missing.close(), empty.close(), duplicate.close()]); }
});

test("canonical path is module-relative and unaffected by process.cwd", async () => {
  const file = await fakeFile("OPENSEA_API_KEY=canonical-test-value\n");
  const originalCwd = process.cwd();
  let requestedPath = "";
  try {
    process.chdir(path.dirname(file.path));
    assert.equal(loadCanonicalProductionOpenSeaApiKey({ readFileSync: (requested, encoding) => { requestedPath = requested; return file.read(requested, encoding); }, ambientValue: undefined }), "canonical-test-value");
    assert.equal(path.normalize(requestedPath), path.normalize(resolveProjectEnvPath()));
  } finally { process.chdir(originalCwd); await file.close(); }
});

test("runtime rejects an ambient key when no explicit key is injected", async () => {
  const previous = process.env.OPENSEA_API_KEY;
  process.env.OPENSEA_API_KEY = "ambient-test-value";
  try {
    let streamConstructed = false;
    const runtime = new ProductionIngestionRuntime({ confirmProductionIngestion: true, createStream: () => { streamConstructed = true; throw new Error("must not construct transport"); } });
    await assert.rejects(() => runtime.start(), /OPENSEA_API_KEY_MISSING/);
    assert.equal(streamConstructed, false);
  } finally {
    if (previous === undefined) delete process.env.OPENSEA_API_KEY;
    else process.env.OPENSEA_API_KEY = previous;
  }
});

test("credential errors never expose the conflicting secret", async () => {
  const file = await fakeFile("OPENSEA_API_KEY=canonical-test-value\n");
  try {
    assert.throws(() => loadCanonicalProductionOpenSeaApiKey({ readFileSync: file.read, ambientValue: "different-secret-sentinel" }), (error: unknown) => error instanceof Error && error.message === PRODUCTION_OPENSEA_API_KEY_SOURCE_CONFLICT && !error.message.includes("different-secret-sentinel"));
  } finally { await file.close(); }
});

test("production entrypoints use the canonical loader instead of ambient precedence", async () => {
  const ingestion = await import("node:fs/promises").then((fsPromises) => fsPromises.readFile(path.resolve(import.meta.dirname, "..", "scripts", "runProductionIngestion.ts"), "utf8"));
  const bootstrap = await import("node:fs/promises").then((fsPromises) => fsPromises.readFile(path.resolve(import.meta.dirname, "..", "src", "cli", "runInitialGenerationBootstrap.ts"), "utf8"));
  assert.match(ingestion, /productionOpenSeaCredential/);
  assert.match(ingestion, /loadCanonicalProductionOpenSeaApiKey/);
  assert.match(ingestion, /apiKey/);
  assert.doesNotMatch(ingestion, /process\.env\.OPENSEA_API_KEY/);
  assert.match(bootstrap, /productionOpenSeaCredential/);
  assert.match(bootstrap, /loadCanonicalProductionOpenSeaApiKey/);
  assert.doesNotMatch(bootstrap, /process\.env\.OPENSEA_API_KEY/);
});
