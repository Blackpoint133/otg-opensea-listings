import { createHash } from "node:crypto";
import { deepStrictEqual } from "node:assert";

export function canonicalEvidence(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("NON_FINITE_NUMBER");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalEvidence).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalEvidence(object[key])}`).join(",")}}`;
  }
  throw new Error("UNSUPPORTED_CANONICAL_VALUE");
}

export function canonicalBytes(value: unknown): Uint8Array { return new TextEncoder().encode(canonicalEvidence(value)); }
export function sha256Bytes(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function sha256Canonical(value: unknown): string { return sha256Bytes(canonicalBytes(value)); }

export function deepFreeze<T>(value: T): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  const object = value as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(object)) {
    const child = object[key];
    if (child !== null && (typeof child === "object" || typeof child === "function") && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

export function canonicalClone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function equalCanonical(left: unknown, right: unknown): boolean {
  try { deepStrictEqual(JSON.parse(canonicalEvidence(left)), JSON.parse(canonicalEvidence(right))); return true; } catch { return false; }
}

export function canonicalDecimal(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("INVALID_DECIMAL_ID");
  return BigInt(value).toString();
}
