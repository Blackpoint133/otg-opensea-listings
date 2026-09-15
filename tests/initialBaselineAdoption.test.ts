import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isTrustedInitialBaselineAdoptionPlan } from "../src/reconciliation/initialBaselineAdoption.js";

test("initial baseline adoption migration declares immutable provenance and constraints", async () => {
  const sql = await readFile(join(process.cwd(), "sql", "009_add_initial_baseline_adoption.sql"), "utf8");
  assert.match(sql, /CREATE TABLE public\.opensea_listings_initial_baseline_adoptions/);
  assert.match(sql, /UNIQUE \(generation_publication_id\)/);
  assert.match(sql, /REFERENCES public\.targeted_verifier_generation_publications/);
  assert.match(sql, /ADD COLUMN protocol_address text NULL/);
  assert.match(sql, /ADD COLUMN initial_baseline_adoption_id text NULL/);
  assert.match(sql, /ADD COLUMN raw_baseline_listing jsonb NULL/);
});

test("structural adoption plans are never trusted", () => {
  const forged = { schemaVersion: "initial-baseline-adoption-v1", adoptionId: "a" };
  assert.equal(isTrustedInitialBaselineAdoptionPlan(forged), false);
  assert.equal(isTrustedInitialBaselineAdoptionPlan({ ...forged }), false);
  assert.equal(isTrustedInitialBaselineAdoptionPlan(JSON.parse(JSON.stringify(forged))), false);
});
