export type LosslessNumber = Readonly<{
    kind: "number";
    raw: string;
}>;
export type LosslessValue = null | boolean | string | LosslessNumber | LosslessValue[] | {
    readonly [key: string]: LosslessValue;
};
export const MAX_JSON_DEPTH = 64;
export const MAX_OBJECT_MEMBERS = 512;
export const MAX_ARRAY_ELEMENTS = 512;
export const MAX_JSON_CHARACTERS = 1_048_576;
// An ordinary provider object with kind/raw keys must never pass the numeric guard.
const NUMBERS = new WeakSet<object>();
export function isJsonNumber(value: unknown): value is LosslessNumber {
    return value !== null && typeof value === "object" && NUMBERS.has(value);
}
export function isJsonObject(value: unknown): value is {
    readonly [key: string]: LosslessValue;
} {
    return value !== null && typeof value === "object" && !Array.isArray(value) && !isJsonNumber(value);
}
export function jsonInt32(value: unknown): number | null {
    if (!isJsonNumber(value) || !/^(0|[1-9][0-9]*)$/.test(value.raw) || BigInt(value.raw) > 2147483647n)
        return null;
    return Number(value.raw);
}
export function parseLosslessJson(text: string): LosslessValue {
    if (typeof text !== "string" || text.length > MAX_JSON_CHARACTERS)
        throw new Error("MALFORMED_JSON");
    let i = 0;
    const ws = () => {
        while (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r") i++;
    };
    const fail = (): never => { throw new Error("MALFORMED_JSON"); };
    const string = (): string => {
        if (text[i++] !== '"')
            fail();
        let out = "";
        while (i < text.length) {
            const c = text[i++];
            if (c === '"')
                return out;
            if (c === "\\") {
                const e = text[i++];
                const m: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
                if (e === "u") {
                    const h = text.slice(i, i + 4);
                    if (!/^[0-9a-f]{4}$/i.test(h))
                        fail();
                    i += 4;
                    const cp = parseInt(h, 16);
                    if (cp >= 0xd800 && cp <= 0xdbff) {
                        if (text.slice(i, i + 2) !== "\\u")
                            fail();
                        i += 2;
                        const h2 = text.slice(i, i + 4);
                        if (!/^[0-9a-f]{4}$/i.test(h2))
                            fail();
                        i += 4;
                        const cp2 = parseInt(h2, 16);
                        if (cp2 < 0xdc00 || cp2 > 0xdfff)
                            fail();
                        out += String.fromCodePoint(0x10000 + ((cp - 0xd800) << 10) + cp2 - 0xdc00);
                    }
                    else if (cp >= 0xdc00 && cp <= 0xdfff)
                        fail();
                    else
                        out += String.fromCharCode(cp);
                }
                else if (m[e] === undefined)
                    fail();
                else
                    out += m[e];
            }
            else {
                if (c < " ")
                    fail();
                const code = c.charCodeAt(0);
                if (code >= 0xdc00 && code <= 0xdfff)
                    fail();
                if (code >= 0xd800 && code <= 0xdbff) {
                    const low = text.charCodeAt(i);
                    if (!(low >= 0xdc00 && low <= 0xdfff))
                        fail();
                    out += c + text[i++];
                }
                else
                    out += c;
            }
        }
        return fail();
    };
    const value = (depth: number): LosslessValue => {
        if (depth > MAX_JSON_DEPTH) fail();
        ws();
        const c = text[i];
        if (c === '"') return string();
        if (c === "{") {
            i++;
            const object: Record<string, LosslessValue> = Object.create(null);
            const keys = new Set<string>();
            ws();
            if (text[i] === "}") { i++; return object; }
            let members = 0;
            while (true) {
                if (++members > MAX_OBJECT_MEMBERS) fail();
                ws();
                const key = string();
                if (keys.has(key)) fail();
                keys.add(key);
                ws();
                if (text[i++] !== ":") fail();
                object[key] = value(depth + 1);
                ws();
                if (text[i] === "}") { i++; return object; }
                if (text[i++] !== ",") fail();
            }
        }
        if (c === "[") {
            i++;
            const array: LosslessValue[] = [];
            ws();
            if (text[i] === "]") { i++; return array; }
            while (true) {
                if (array.length >= MAX_ARRAY_ELEMENTS) fail();
                array.push(value(depth + 1));
                ws();
                if (text[i] === "]") { i++; return array; }
                if (text[i++] !== ",") fail();
            }
        }
        if (text.startsWith("true", i)) { i += 4; return true; }
        if (text.startsWith("false", i)) { i += 5; return false; }
        if (text.startsWith("null", i)) { i += 4; return null; }
        const match = text.slice(i).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
        if (!match) return fail();
        i += match[0].length;
        const number = Object.freeze({ kind: "number" as const, raw: match[0] });
        NUMBERS.add(number);
        return number;
    };
    const result = value(0);
    ws();
    if (i !== text.length)
        fail();
    return result;
}
