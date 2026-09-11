import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLosslessJson, isJsonNumber, jsonInt32, MAX_JSON_DEPTH, MAX_OBJECT_MEMBERS, MAX_ARRAY_ELEMENTS } from "../src/reconciliation/verifier/losslessJson.js";

test("provider-controlled kind/raw objects cannot impersonate number tokens", () => {
  const fake = parseLosslessJson('{"kind":"number","raw":"2"}');
  assert.equal(isJsonNumber(fake), false);
  assert.equal(jsonInt32(fake), null);
  assert.equal(jsonInt32(parseLosslessJson("2147483647")), 2147483647);
  for (const raw of ['"2"', '2.0', '2e0', '-0', '2147483648']) assert.equal(jsonInt32(parseLosslessJson(raw)), null);
});

test("JSON objects use own null-prototype storage including prototype-like keys", () => {
  const value = parseLosslessJson('{"__proto__":{"polluted":true},"constructor":null}');
  assert.equal(Object.getPrototypeOf(value), null);
  assert.equal(Object.hasOwn(value as object, "__proto__"), true);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
test("JSON arrays and only the four JSON whitespace characters", () => {
  assert.deepEqual(parseLosslessJson(' \t\r\n[true, false, null, "value"]\n'), [true, false, null, "value"]);
});
for (const char of ["\u00a0", "\ufeff", "\u2028", "\u2029"]) {
  test(`non-JSON whitespace U+${char.charCodeAt(0).toString(16)} rejected outside strings`, () => {
    for (const text of [char + "[]", "[]" + char, "[" + char + "null]"]) assert.throws(() => parseLosslessJson(text));
    assert.equal(parseLosslessJson('"' + char + '"'), char);
  });
}
test("decoded equivalent keys and nested duplicate keys reject", () => {
  for (const text of ['{"a":1,"a":2}', '{"x":{"a":1,"a":2}}', '{"a":1,"\\u0061":2}']) assert.throws(() => parseLosslessJson(text));
});
test("BMP escapes including non-surrogate upper BMP are accepted", () => {
  assert.equal(parseLosslessJson('"\\u0061\\uE000\\uFFFF"'), "a\ue000\uffff");
});
test("surrogate pair consumes exactly its own escape in values and keys", () => {
  assert.equal(parseLosslessJson('"\\uD83D\\uDE00"'), "😀");
  assert.equal(parseLosslessJson('"\\uD83D\\uDE00tail"'), "😀tail");
  const result = parseLosslessJson('{"\\uD83D\\uDE00":"ok"}') as Record<string, unknown>;
  assert.equal(result["😀"], "ok");
  assert.equal(parseLosslessJson('"😀"'), "😀");
});
test("unpaired escaped and literal surrogates reject", () => {
  for (const text of ['"\\uD83D"', '"\\uDE00"', '"\\uD83D\\u0041"', '"\ud800"', '"\udc00"']) assert.throws(() => parseLosslessJson(text));
});
test("invalid escapes, truncation, controls and trailing garbage reject", () => {
  for (const text of ['"\\x20"', '"\\u00ZZ"', '"abc', '"a\nb"', '{} null', '[1,]', '{"a":1,}', '[', '+1', '01']) assert.throws(() => parseLosslessJson(text));
});
test("number lexical tokens retain exact type and precision", () => {
  for (const raw of ["0", "1", "-1", "-0", "1.0", "1e0", "9007199254740992", "9223372036854775807"]) {
    assert.deepEqual(parseLosslessJson(raw), { kind: "number", raw });
    assert.notDeepEqual(parseLosslessJson(raw), parseLosslessJson(JSON.stringify(raw)));
  }
  const huge = "9".repeat(120);
  assert.equal(parseLosslessJson(JSON.stringify(huge)), huge);
});
test("depth bound rejects overflow", () => assert.throws(() => parseLosslessJson("[".repeat(MAX_JSON_DEPTH + 2) + "0" + "]".repeat(MAX_JSON_DEPTH + 2))));
test("member bound accepts limit and rejects overflow", () => {
  const object = (n: number) => "{" + Array.from({ length: n }, (_, i) => JSON.stringify(String(i)) + ":null").join(",") + "}";
  assert.doesNotThrow(() => parseLosslessJson(object(MAX_OBJECT_MEMBERS)));
  assert.throws(() => parseLosslessJson(object(MAX_OBJECT_MEMBERS + 1)));
});
test("array bound accepts limit and rejects overflow", () => {
  assert.doesNotThrow(() => parseLosslessJson(JSON.stringify(Array(MAX_ARRAY_ELEMENTS).fill(null))));
  assert.throws(() => parseLosslessJson(JSON.stringify(Array(MAX_ARRAY_ELEMENTS + 1).fill(null))));
});
