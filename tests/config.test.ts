import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, parsePositiveNumber } from "../src/config.js";

test("missing OPENSEA_API_KEY is rejected", () => assert.throws(() => loadConfig([], { OPENSEA_API_KEY: "" }), /OPENSEA_API_KEY/));
test("duration and max-events validate positive numbers", () => {
  assert.equal(parsePositiveNumber("2", "duration", 1), 2);
  assert.throws(() => parsePositiveNumber("0", "duration", 1), /positive/);
  assert.throws(() => parsePositiveNumber("abc", "max-events", 1), /positive/);
});

test("connection error thresholds have safe defaults", () => {
  const config = loadConfig([], { OPENSEA_API_KEY: "test-key" });
  assert.equal(config.maxConsecutiveConnectionErrors, 10);
  assert.equal(config.connectionErrorWindowSeconds, 120);
});
