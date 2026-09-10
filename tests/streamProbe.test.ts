import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { LocalStorage } from "node-localstorage";
import { LogLevel } from "@opensea/stream-js";
import { installConsoleCapture, redactString, serializeDiagnostic } from "../src/logger.js";
import { applySdkConsoleMessage, ConnectionErrorTracker, createInitialProbeState, createStreamClient } from "../src/streamProbe.js";

test("LocalStorage is passed as Phoenix sessionStorage, not localStorage", () => {
  const directory = path.resolve("tests", "fixtures", "session_storage_test");
  fs.mkdirSync(directory, { recursive: true });
  const storage = new LocalStorage(directory);
  const client = createStreamClient("test-key", storage, () => {}, LogLevel.DEBUG) as any;
  assert.equal(client.socket.sessionStore, storage);
  assert.equal(client.socket.transport, WebSocket);
  assert.equal(client.socket.localStorage, undefined);
  client.disconnect();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("symbol ErrorEvent data exposes nested AggregateError details", () => {
  const symbol = Symbol("kError");
  const aggregate = new AggregateError([Object.assign(new Error("reset"), { code: "ECONNRESET", syscall: "connect", address: "127.0.0.1", port: 443 })], "network");
  const event = { [symbol]: aggregate };
  const output = serializeDiagnostic(event);
  const text = JSON.stringify(output);
  assert.match(text, /kError/);
  assert.match(text, /ECONNRESET/);
  assert.match(text, /127\.0\.0\.1/);
});

test("EACCES and circular values are safely formatted", () => {
  const value: Record<string, unknown> = { code: "EACCES", message: "connect denied" };
  value.self = value;
  const output = serializeDiagnostic(value);
  assert.match(JSON.stringify(output), /EACCES/);
  assert.match(JSON.stringify(output), /CIRCULAR/);
});

test("API key and token query parameters are redacted while public hashes remain", () => {
  assert.equal(redactString("wss://stream.example/socket?token=secret-value"), "wss://stream.example/socket?token=<REDACTED>");
  const publicData = serializeDiagnostic({ order_hash: "0xorder", wallet: "0xwallet", transaction_hash: "0xtx", url: "?token=secret" });
  const text = JSON.stringify(publicData);
  assert.match(text, /0xorder/);
  assert.match(text, /0xwallet/);
  assert.match(text, /0xtx/);
  assert.doesNotMatch(text, /secret/);
});

test("first transient error is not fatal and threshold inside window is fatal", () => {
  const tracker = new ConnectionErrorTracker(3, 120000);
  assert.equal(tracker.record(0).fatal, false);
  assert.equal(tracker.record(1000).fatal, false);
  assert.equal(tracker.record(2000).fatal, true);
  tracker.markHealthy();
  assert.equal(tracker.record(200000).fatal, false);
});

test("activity resets the consecutive error counter", () => {
  const tracker = new ConnectionErrorTracker(2, 120000);
  const state = createInitialProbeState();
  assert.equal(tracker.record(0).consecutive, 1);
  state.subscription_registered = true;
  assert.equal(state.channel_join_confirmed, false);
  applySdkConsoleMessage(state, "Successfully joined channel \"collection:off-the-grid\"", "off-the-grid", tracker);
  assert.equal(state.subscription_registered, true);
  assert.equal(state.channel_join_confirmed, true);
  assert.equal(tracker.record(1000).consecutive, 1);
});

test("console capture restores original methods", () => {
  const originalDebug = console.debug;
  const captured: string[] = [];
  const capture = installConsoleCapture((level, args) => captured.push(`${level}:${String(args[0])}`));
  console.debug("captured");
  capture.restore();
  assert.equal(console.debug, originalDebug);
  assert.deepEqual(captured, ["debug:captured"]);
});
