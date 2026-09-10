import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeRestEvent,
  defaultRestContractProbePlan,
  discoverRestFieldPaths,
  parseRestContractProbeArgs,
  runRestContractProbe,
  validateRestContractProbeConfig,
  type RestContractProbeConfig
} from "../src/probe/restContractProbe.js";

const nowSeconds = 1_786_000_000;
const nowIso = "2026-08-13T12:00:00.000Z";

function config(outputDir: string, overrides: Partial<RestContractProbeConfig> = {}): RestContractProbeConfig {
  return {
    after: nowSeconds - 600,
    before: nowSeconds - 300,
    outputDir,
    pageLimit: 50,
    maxPagesPerQuery: 2,
    maxEventsPerQuery: 100,
    maxTotalRequests: 10,
    requestTimeoutMs: 30_000,
    maxWindowSeconds: 3_600,
    maxAttempts: 2,
    allowedClockSkewSeconds: 300,
    confirmLiveReadOnly: true,
    confirmNoDbWrite: true,
    confirmOpenseaRest: true,
    ...overrides
  };
}

function tmpDir(): string {
  return path.join(os.tmpdir(), `otg-rest-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function listing(): any {
  return {
    event_type: "listing",
    version: "1786422067000",
    event_timestamp: "2026-08-11T04:21:07.000Z",
    order: { hash: "0x1111111111111111111111111111111111111111111111111111111111111111" },
    nft: { identifier: "9007199254740993", contract: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271" },
    maker: { address: "0x2222222222222222222222222222222222222222" },
    price: "1234500000000000000",
    payment_token: { decimals: 18 }
  };
}

function sale(): any {
  return {
    event_type: "sale",
    event_version: "1786422068000",
    created_date: "2026-08-11T04:21:08.000Z",
    order_hash: "0x3333333333333333333333333333333333333333333333333333333333333333",
    nft: { token_id: "9007199254740994", contract_address: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271" },
    seller: { address: "0x4444444444444444444444444444444444444444" },
    buyer: { address: "0x5555555555555555555555555555555555555555" },
    sale_price: "2000000000000000000",
    payment_token: { decimals: 18 },
    transaction: { hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  };
}

function transfer(): any {
  return {
    eventType: "transfer",
    eventVersion: "1786422069000",
    timestamp: "1786422069",
    chain: "gunzilla",
    transfer_type: "transfer",
    nft: { identifier: "9007199254740995", contract: { address: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271" } },
    from_address: "0x0000000000000000000000000000000000000000",
    to_address: "0x6666666666666666666666666666666666666666",
    transaction_hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  };
}

function realShapeTransferNoVersion(): any {
  return {
    event_type: "transfer",
    event_timestamp: 1786618795,
    transaction: "0x3af17f9c9e29eb435a747573bfba623f63a31b9fda835588b216838862eefeb3",
    chain: "gunzilla",
    transfer_type: "transfer",
    from_address: "0xb93a9f4a1b41cb81b023b4efa7b6790c42f0437b",
    to_address: "0xf825620abf4f5e1d501dfc6f8f836846b5d7a3fc",
    nft: {
      identifier: "26224807",
      collection: "off-the-grid",
      contract: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271",
      token_standard: "erc721"
    },
    quantity: 1
  };
}

function httpResponse(status: number, bodyText: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { throw new Error("response.json must not be used"); },
    async text() { return bodyText; }
  };
}

function body(events: unknown[], next: string | null = null): string {
  return JSON.stringify({ asset_events: events, next });
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("probe gates and required args fail before network-capable execution", () => {
  const env = { OPENSEA_API_KEY: "secret" };
  assert.throws(() => parseRestContractProbeArgs([], env), /--output-dir|required/);
  const missingGate = parseRestContractProbeArgs(["--confirm-live-read-only", "--confirm-no-db-write", "--after", "1", "--before", "2", "--output-dir", "out"], env);
  assert.throws(() => validateRestContractProbeConfig(missingGate, nowSeconds), /confirmation gates/);
  assert.throws(() => parseRestContractProbeArgs(["--confirm-live-read-only", "--confirm-no-db-write", "--confirm-opensea-rest", "--after", "1", "--before", "2", "--output-dir", "out", "--mode", "bad"], env), /unknown argument/);
  assert.throws(() => parseRestContractProbeArgs(["--confirm-live-read-only", "--confirm-no-db-write", "--confirm-opensea-rest", "--after", "1", "--before", "2", "--output-dir", "out"], {}), /OPENSEA_API_KEY/);
});

test("probe validates explicit bounded windows and future skew", () => {
  assert.doesNotThrow(() => validateRestContractProbeConfig(config("out"), nowSeconds));
  assert.throws(() => validateRestContractProbeConfig(config("out", { after: 1, before: 1 }), nowSeconds), /after must be lower/);
  assert.throws(() => validateRestContractProbeConfig(config("out", { after: -1 }), nowSeconds), /non-negative/);
  assert.throws(() => validateRestContractProbeConfig(config("out", { after: nowSeconds - 10_000, before: nowSeconds }), nowSeconds), /maxWindowSeconds/);
  assert.throws(() => validateRestContractProbeConfig(config("out", { before: nowSeconds + 301 }), nowSeconds), /clock skew/);
});

test("default query plan samples unfiltered listing sale transfer and mint only", () => {
  const plan = defaultRestContractProbePlan();
  assert.deepEqual(plan.map((profile) => profile.name), ["unfiltered", "listing", "sale", "transfer", "mint"]);
  assert.deepEqual(plan.flatMap((profile) => profile.eventTypes), ["listing", "sale", "transfer", "mint"]);
  assert.equal(plan.some((profile) => profile.eventTypes.includes("cancel")), false);
  assert.equal(plan.some((profile) => profile.eventTypes.includes("order_invalidate") || profile.eventTypes.includes("order_revalidate")), false);
  assert.equal(plan.some((profile) => profile.eventTypes.includes("offer") || profile.eventTypes.includes("trait_offer") || profile.eventTypes.includes("collection_offer")), false);
});

test("field discovery reports actual varied paths and primitive types", () => {
  const fields = discoverRestFieldPaths({ outer: { event_version: "9007199254740993", order: { hash: "0xabc" }, transaction: { hash: "0xdef" }, nft: { identifier: "42" }, from: { address: "0x1" }, to_address: null, created_date: 1786422067 } });
  assert.equal(fields.version.some((field) => field.path === "outer.event_version" && field.type === "string"), true);
  assert.equal(fields.orderHash.some((field) => field.path === "outer.order.hash"), true);
  assert.equal(fields.transactionHash.some((field) => field.path === "outer.transaction.hash"), true);
  assert.equal(fields.nftIdentity.some((field) => field.path === "outer.nft.identifier"), true);
  assert.equal(fields.timestamp.some((field) => field.path === "outer.created_date" && field.type === "number"), true);
  assert.equal(fields.timestamp.some((field) => field.path === "outer.created_date" && field.numericSafety === "safe_integer" && field.unsafeNumber === false), true);
});

test("event analysis performs adapter and production dedupe dry-run without fallback", () => {
  for (const event of [listing(), sale(), transfer()]) {
    const analysis = analyzeRestEvent(event, 1, "profile", nowIso);
    assert.equal(analysis.adapterClassification, "adapted");
    assert.equal(analysis.usedFallbackDedupe, false);
    assert.match(String(analysis.dedupeKey), /^(order|transfer):v1:/);
    assert.ok(analysis.normalizedBusinessTimestamp);
    assert.ok(analysis.normalizedEventVersion);
  }
  const mint = analyzeRestEvent({ event_type: "mint", nft: { identifier: "1" } }, 2, "mint", nowIso);
  assert.equal(mint.adapterClassification, "unsupported");
  const missing = analyzeRestEvent({ ...listing(), version: undefined }, 3, "listing", nowIso);
  assert.equal(missing.adapterClassification, "malformed");
  assert.equal(missing.dedupeKey, null);
});

test("probe field discovery recognizes real REST top-level transaction hash", async () => {
  const analysis = analyzeRestEvent(realShapeTransferNoVersion(), 1, "transfer", nowIso);
  const txFields = analysis.candidateTransactionHashFields as any[];
  assert.equal(txFields.some((field) => field.path === "transaction" && field.type === "string"), true);

  const out = tmpDir();
  const summary = await runRestContractProbe(config(out, { maxTotalRequests: 1 }), {
    env: { OPENSEA_API_KEY: "secret-key" },
    nowSeconds: () => nowSeconds,
    nowIso: () => nowIso,
    fetch: async () => httpResponse(200, body([realShapeTransferNoVersion()]))
  });
  assert.equal(summary.transferTxHashPresentCount, 1);
});

test("probe writes valid local evidence and persists no secrets", async () => {
  const out = tmpDir();
  let calls = 0;
  const summary = await runRestContractProbe(config(out), {
    env: { OPENSEA_API_KEY: "secret-key" },
    nowSeconds: () => nowSeconds,
    nowIso: () => nowIso,
    sleep: async () => {},
    random: () => 0,
    fetch: async (_url, init) => {
      calls += 1;
      assert.equal(init.headers["X-API-KEY"], "secret-key");
      if (calls === 1) return httpResponse(202, body([transfer(), { event_type: "cancel" }, { event_type: "offer" }]));
      if (calls === 2) return httpResponse(200, body([listing()]));
      if (calls === 3) return httpResponse(200, body([sale()]));
      if (calls === 4) return httpResponse(200, body([transfer()]));
      return httpResponse(200, body([{ event_type: "mint", nft: { identifier: "1" } }]));
    }
  });
  assert.equal(summary.databaseTouched, false);
  assert.equal(summary.streamConnected, false);
  assert.equal(summary.txAInvoked, false);
  assert.equal(summary.txBInvoked, false);
  assert.equal(summary.cancelObservedCount, 1);
  assert.equal(summary.offerExcludedCount, 1);
  assert.equal(summary.mintCount, 1);
  assert.equal(summary.structuredDedupeCount, 4);
  assert.equal(summary.fallbackDedupeCount, 0);
  assert.equal(summary.crossSourceEquivalenceProven, false);
  const raw = fs.readFileSync(path.join(out, "raw_pages.jsonl"), "utf8");
  const analysis = fs.readFileSync(path.join(out, "event_analysis.jsonl"), "utf8");
  const summaryFile = JSON.parse(fs.readFileSync(path.join(out, "probe_summary.json"), "utf8"));
  assert.doesNotMatch(`${raw}\n${analysis}\n${JSON.stringify(summaryFile)}`, /secret-key|X-API-KEY|OPENSEA_API_KEY/);
  assert.equal(raw.trim().split(/\r?\n/).every((line) => JSON.parse(line)), true);
  const rawFirst = JSON.parse(raw.trim().split(/\r?\n/)[0]);
  assert.equal(rawFirst.httpStatus, 202);
  assert.equal(typeof rawFirst.literalResponseText, "string");
  assert.equal(rawFirst.literalResponseSha256, sha256Text(rawFirst.literalResponseText));
  assert.equal(rawFirst.literalResponseByteLength, Buffer.byteLength(rawFirst.literalResponseText, "utf8"));
  assert.equal("rawResponseBody" in rawFirst, false);
  assert.equal(analysis.trim().split(/\r?\n/).every((line) => JSON.parse(line)), true);
});

test("probe distinguishes partial profile results and truncation from failed config", async () => {
  const out = tmpDir();
  let calls = 0;
  const summary = await runRestContractProbe(config(out, { maxPagesPerQuery: 1 }), {
    env: { OPENSEA_API_KEY: "secret-key" },
    nowSeconds: () => nowSeconds,
    nowIso: () => nowIso,
    fetch: async () => {
      calls += 1;
      return httpResponse(200, body(calls === 1 ? [transfer()] : [], calls === 1 ? "more" : null));
    }
  });
  assert.equal(summary.result, "REST_CONTRACT_PROBE_PARTIAL");
  assert.deepEqual(summary.truncatedProfiles, ["unfiltered"]);
});

test("literal response text is preserved before parsing and unsafe numeric tokens are visible", async () => {
  const out = tmpDir();
  const literal = '{\n  "asset_events": [ { "event_type": "listing", "version":9007199254740995, "event_timestamp":"2026-08-11T04:21:07.000Z", "order_hash":"0x1111111111111111111111111111111111111111111111111111111111111111", "nft":{"identifier":"9007199254740993","contract":"0x9ed98e159be43a8d42b64053831fcae5e4d7d271"}, "seller":{"address":"0x2222222222222222222222222222222222222222"}, "price":"1", "payment_token":{"decimals":18} } ],\n  "next": null\n}';
  const summary = await runRestContractProbe(config(out, { maxTotalRequests: 1 }), {
    env: { OPENSEA_API_KEY: "secret-key" },
    nowSeconds: () => nowSeconds,
    nowIso: () => nowIso,
    fetch: async () => httpResponse(200, literal)
  });
  const rawLine = JSON.parse(fs.readFileSync(path.join(out, "raw_pages.jsonl"), "utf8").trim());
  assert.equal(rawLine.literalResponseText, literal);
  assert.match(rawLine.literalResponseText, /"version":9007199254740995/);
  assert.equal(rawLine.literalResponseSha256, sha256Text(literal));
  assert.equal(rawLine.literalResponseByteLength, Buffer.byteLength(literal, "utf8"));
  const analysis = JSON.parse(fs.readFileSync(path.join(out, "event_analysis.jsonl"), "utf8").trim());
  assert.equal(analysis.unsafeParsedNumberCount > 0, true);
  assert.equal(analysis.identityCriticalUnsafeNumber, true);
  assert.equal(analysis.trustworthyStructuredDedupe, false);
  assert.equal(summary.eventsWithUnsafeParsedNumbers, 1);
  assert.equal(summary.eventsWithIdentityCriticalUnsafeNumbers, 1);
  assert.equal(summary.crossSourceAlgorithmReady, false);
});

test("bigint-like strings remain exact and are not flagged as unsafe numbers", () => {
  const analysis = analyzeRestEvent(listing(), 1, "listing", nowIso);
  const versionFields = analysis.candidateVersionFields as any[];
  assert.equal(versionFields.some((field) => field.value === "1786422067000" && field.unsafeNumber === false && field.numericSafety === "not_numeric"), true);
  assert.equal(analysis.unsafeParsedNumberCount, 0);
});

test("successful invalid JSON preserves literal response evidence and cannot complete", async () => {
  const out = tmpDir();
  const literal = "not valid json 9007199254740995";
  const summary = await runRestContractProbe(config(out, { maxTotalRequests: 1 }), {
    env: { OPENSEA_API_KEY: "secret-key" },
    nowSeconds: () => nowSeconds,
    nowIso: () => nowIso,
    fetch: async () => httpResponse(200, literal)
  });
  assert.equal(summary.result, "REST_CONTRACT_PROBE_FAILED");
  assert.match(summary.sanitizedErrors.join("\n"), /JSON parse/);
  const rawLine = JSON.parse(fs.readFileSync(path.join(out, "raw_pages.jsonl"), "utf8").trim());
  assert.equal(rawLine.literalResponseText, literal);
  assert.equal(rawLine.literalResponseSha256, sha256Text(literal));
  assert.equal(fs.existsSync(path.join(out, "event_analysis.jsonl")), false);
});

test("evidence writer failures never return complete", async () => {
  const baseWriter = {
    rawPagesPath: "raw_pages.jsonl",
    analysisPath: "event_analysis.jsonl",
    appendRawPage: async (_value: unknown) => {},
    appendAnalysis: async (_value: unknown) => {},
    writeSummary: async (_value: unknown) => {}
  };
  const runWithWriter = (writer: typeof baseWriter) => runRestContractProbe(config(tmpDir(), { maxTotalRequests: 1 }), {
    env: { OPENSEA_API_KEY: "secret-key" },
    nowSeconds: () => nowSeconds,
    nowIso: () => nowIso,
    fetch: async () => httpResponse(200, body([transfer()])),
    evidenceWriters: writer
  });

  const rawFailure = await runWithWriter({ ...baseWriter, appendRawPage: async () => { throw new Error("raw append failed"); } });
  assert.equal(rawFailure.result, "REST_CONTRACT_PROBE_FAILED");
  assert.match(rawFailure.sanitizedErrors.join("\n"), /raw append failed/);

  const analysisFailure = await runWithWriter({ ...baseWriter, appendAnalysis: async () => { throw new Error("analysis append failed"); } });
  assert.equal(analysisFailure.result, "REST_CONTRACT_PROBE_FAILED");
  assert.match(analysisFailure.sanitizedErrors.join("\n"), /analysis append failed/);

  const summaryTempFailure = await runWithWriter({ ...baseWriter, writeSummary: async () => { throw new Error("summary temp write failed"); } });
  assert.equal(summaryTempFailure.result, "REST_CONTRACT_PROBE_FAILED");
  assert.match(summaryTempFailure.sanitizedErrors.join("\n"), /summary write failed/);

  const renameFailure = await runWithWriter({ ...baseWriter, writeSummary: async () => { throw new Error("rename failed"); } });
  assert.equal(renameFailure.result, "REST_CONTRACT_PROBE_FAILED");
  assert.match(renameFailure.sanitizedErrors.join("\n"), /rename failed/);
});

test("output directory safety fails for non-empty directories and does not delete unrelated files", async () => {
  const out = tmpDir();
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, "keep.txt"), "keep");
  await assert.rejects(
    () => runRestContractProbe(config(out), { env: { OPENSEA_API_KEY: "secret-key" }, nowSeconds: () => nowSeconds, fetch: async () => { throw new Error("should not fetch"); } }),
    /output directory/
  );
  assert.equal(fs.readFileSync(path.join(out, "keep.txt"), "utf8"), "keep");
});

test("probe source and command are DB and Stream independent", () => {
  const probe = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "probe", "restContractProbe.ts"), "utf8")
    + fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "probe", "runRestContractProbe.ts"), "utf8");
  assert.doesNotMatch(probe, /\bpg\b|Pool|server_otg|persistRawEventToInbox|DurableInboxRuntimeController|runDurableInboxWorkerOnce|applyPendingInboxEvent|LiveEventWriter|applyNormalizedEvent|OpenSeaStreamClient|stream-js/);
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.equal(pkg.scripts.probe, "node dist/probe/runRestContractProbe.js");
  assert.doesNotMatch(`${pkg.scripts.build} ${pkg.scripts.test} ${pkg.scripts.start} ${pkg.scripts.canary} ${pkg.scripts["canary:durable"]}`, /runRestContractProbe/);
});
