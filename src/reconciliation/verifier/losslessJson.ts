export type LosslessNumber = Readonly<{ kind: "number"; raw: string }>;
export type LosslessValue = null | boolean | string | LosslessNumber | LosslessValue[] | { readonly [key: string]: LosslessValue };
export const MAX_JSON_DEPTH = 64;
export const MAX_OBJECT_MEMBERS = 512;
export const MAX_ARRAY_ELEMENTS = 512;

export function parseLosslessJson(text: string): LosslessValue {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const fail = (): never => { throw new Error("MALFORMED_JSON"); };
  const string = (): string => { if (text[i++] !== '"') fail(); let out = ""; while (i < text.length) { const c = text[i++]; if (c === '"') return out; if (c === "\\") { const e = text[i++]; const m: Record<string,string> = { '"':'"', "\\":"\\", "/":"/", b:"\b", f:"\f", n:"\n", r:"\r", t:"\t" }; if (e === "u") { const h = text.slice(i, i + 4); if (!/^[0-9a-f]{4}$/i.test(h)) fail(); i += 4; const cp = parseInt(h, 16); if (cp >= 0xd800 && cp <= 0xdbff) { if (text.slice(i, i + 2) !== "\\u") fail(); i += 2; const h2 = text.slice(i, i + 4); if (!/^[0-9a-f]{4}$/i.test(h2)) fail(); i += 4; const cp2 = parseInt(h2, 16); if (cp2 < 0xdc00 || cp2 > 0xdfff) fail(); i += 4; out += String.fromCodePoint(0x10000 + ((cp - 0xd800) << 10) + cp2 - 0xdc00); } else if (cp >= 0xdc00) fail(); else out += String.fromCharCode(cp); } else if (m[e] === undefined) fail(); else out += m[e]; } else { if (c < " ") fail(); out += c; } } return fail(); };
  const value = (depth: number): LosslessValue => { if (depth > MAX_JSON_DEPTH) fail(); ws(); const c = text[i]; if (c === '"') return string(); if (c === "{") { i++; const o: Record<string, LosslessValue> = Object.create(null); const keys = new Set<string>(); ws(); if (text[i] === "}") { i++; return o; } let n = 0; while (true) { if (++n > MAX_OBJECT_MEMBERS) fail(); ws(); const k = string(); if (keys.has(k)) fail(); keys.add(k); ws(); if (text[i++] !== ":") fail(); o[k] = value(depth + 1); ws(); if (text[i] === "}") { i++; return o; } if (text[i++] !== ",") fail(); } } if (c === "[") { i++; const a: LosslessValue[] = []; ws(); if (text[i] === "]") { i++; return a; } while (true) { if (a.length >= MAX_ARRAY_ELEMENTS) fail(); a.push(value(depth + 1)); ws(); if (text[i] === "]") { i++; return a; } if (text[i++] !== ",") fail(); } } if (text.startsWith("true", i)) { i += 4; return true; } if (text.startsWith("false", i)) { i += 5; return false; } if (text.startsWith("null", i)) { i += 4; return null; } const m = text.slice(i).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/); if (m) { i += m[0].length; return { kind: "number", raw: m[0] }; } return fail(); };
  const result = value(0); ws(); if (i !== text.length) fail(); return result;
}
