import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isTrustedInitialBaselineAdoptionPlan } from "../src/reconciliation/initialBaselineAdoption.js";
import { persistInitialBaselineSnapshotArtifact } from "../src/reconciliation/initialBaselineAdoption.js";
import { ActiveListingsClient, ACTIVE_LISTINGS_CONTRACT } from "../src/activeListings.js";

function rawListing(): any { return { order_hash: `0x${"1".repeat(64)}`, chain: "gunzilla", protocol_address: `0x${"a".repeat(40)}`, asset: { identifier: "7", contract: ACTIVE_LISTINGS_CONTRACT }, remaining_quantity: 1, protocol_data: { parameters: { offerer: `0x${"2".repeat(40)}`, offer: [{ itemType: 2, token: ACTIVE_LISTINGS_CONTRACT, identifierOrCriteria: "7", startAmount: "1", endAmount: "1" }], consideration: [{ itemType: 0, token: `0x${"0".repeat(40)}`, identifierOrCriteria: "0", startAmount: "1000000000000000000", endAmount: "1000000000000000000", recipient: `0x${"2".repeat(40)}` }], startTime: "1787323440", endTime: "1789915440", orderType: 0 } }, price: { current: { currency: "GUN", decimals: 18, value: "1000000000000000000" } }, order_created_at: 1787323444, type: "basic", status: "ACTIVE" }; }

async function completeEvidence(): Promise<any> { const client = new ActiveListingsClient({ apiKey: "test", dependencies: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ listings: [rawListing()], next: null }) }) as any, sleep: async () => undefined }, policy: { maxPages: 1, maxListings: 10 }, retryPolicy: { maxRetries: 0 } }); return { sourceProvenance: { fixture: "a".repeat(64) }, snapshot: await client.fetchSnapshot("2026-09-01T00:00:00.000Z", { fixture: "a".repeat(64) }) }; }

test("initial baseline adoption migration declares immutable provenance and constraints", async () => {
  const sql = await readFile(join(process.cwd(), "sql", "009_add_initial_baseline_adoption.sql"), "utf8");
  assert.match(sql, /CREATE TABLE public\.opensea_listings_initial_baseline_adoptions/);
  assert.match(sql, /UNIQUE \(generation_publication_id\)/);
  assert.match(sql, /REFERENCES public\.targeted_verifier_generation_publications/);
  assert.match(sql, /ADD COLUMN protocol_address text NULL/);
  assert.match(sql, /ADD COLUMN initial_baseline_adoption_id text NULL/);
  assert.match(sql, /ADD COLUMN raw_baseline_listing jsonb NULL/);
  assert.match(sql, /snapshot_artifact_hash text NOT NULL/);
  assert.match(sql, /snapshot_artifact_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
});

test("structural adoption plans are never trusted", () => {
  const forged = { schemaVersion: "initial-baseline-adoption-v1", adoptionId: "a" };
  assert.equal(isTrustedInitialBaselineAdoptionPlan(forged), false);
  assert.equal(isTrustedInitialBaselineAdoptionPlan({ ...forged }), false);
  assert.equal(isTrustedInitialBaselineAdoptionPlan(JSON.parse(JSON.stringify(forged))), false);
});

test("complete snapshot is persisted through the accepted evidence writer artifact contract", async () => {
  const evidence = await completeEvidence();
  const calls: any[] = [];
  const writer: any = { writeArtifact: async (input: any) => { calls.push(input); return { artifactType: input.artifactType, artifactId: input.artifactId, relativePath: input.relativePath, schemaVersion: input.schemaVersion, sweepId: "sweep", contentHash: "" }; } };
  const { sha256Canonical } = await import("../src/reconciliation/evidence/canonicalEvidence.js");
  writer.writeArtifact = async (input: any) => { calls.push(input); return { ...input, sweepId: "sweep", contentHash: sha256Canonical(input.payload) }; };
  const result = await persistInitialBaselineSnapshotArtifact(writer, evidence);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].artifactType, "transport");
  assert.equal(calls[0].artifactId, "initial-active-listings-snapshot");
  assert.equal(calls[0].relativePath, "initial-active-listings-snapshot.json");
  assert.equal(result.contentHash, sha256Canonical(evidence));
});
