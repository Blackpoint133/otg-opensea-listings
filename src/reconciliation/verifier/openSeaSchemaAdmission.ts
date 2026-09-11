import { isJsonNumber, isJsonObject, jsonString, type LosslessJsonValue } from "./losslessJson.js";

const own = (o: Record<string, LosslessJsonValue>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const stringField = (o: Record<string, LosslessJsonValue>, k: string) => own(o, k) && jsonString(o[k]) !== null;

type IntegerMagnitude = Readonly<{ negative: boolean; digits: string; appendedZeros: number | "HUGE" }>;

/** Exact JSON Schema integer semantics without an intermediate JavaScript Number. */
function officialIntegerMagnitude(value: unknown): IntegerMagnitude | null {
  if (!isJsonNumber(value)) return null;
  const match = /^(-)?(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?)([0-9]+))?$/.exec(value.raw);
  if (!match) return null;
  const rawDigits = match[2] + (match[3] ?? "");
  let digits = rawDigits.replace(/^0+/, "");
  if (digits === "") return { negative: false, digits: "0", appendedZeros: 0 };

  const exponentDigits = (match[5] ?? "0").replace(/^0+/, "") || "0";
  const exponentNegative = match[4] === "-";
  if (exponentDigits.length > 9)
    return exponentNegative ? null : { negative: match[1] === "-", digits, appendedZeros: "HUGE" };
  const exponent = Number(exponentDigits) * (exponentNegative ? -1 : 1);
  const shift = exponent - (match[3]?.length ?? 0);
  if (shift >= 0) return { negative: match[1] === "-", digits, appendedZeros: shift };

  const removed = -shift;
  if (removed > rawDigits.length || !rawDigits.endsWith("0".repeat(removed))) return null;
  digits = rawDigits.slice(0, rawDigits.length - removed).replace(/^0+/, "") || "0";
  return { negative: digits !== "0" && match[1] === "-", digits, appendedZeros: 0 };
}

export function isOfficialJsonInteger(value: unknown): boolean {
  return officialIntegerMagnitude(value) !== null;
}

function officialBoundedInteger(value: unknown, minimum: bigint, maximum: bigint): bigint | null {
  const magnitude = officialIntegerMagnitude(value);
  if (!magnitude || magnitude.appendedZeros === "HUGE") return null;
  const maximumDigits = [minimum < 0n ? -minimum : minimum, maximum < 0n ? -maximum : maximum]
    .reduce((a, b) => a > b ? a : b).toString().length;
  if (magnitude.digits.length + magnitude.appendedZeros > maximumDigits) return null;
  const unsigned = BigInt(magnitude.digits + "0".repeat(magnitude.appendedZeros));
  const result = magnitude.negative ? -unsigned : unsigned;
  return result >= minimum && result <= maximum ? result : null;
}

export function officialJsonInt32Value(value: unknown): number | null {
  const result = officialBoundedInteger(value, -2147483648n, 2147483647n);
  return result === null ? null : Number(result);
}

export function officialJsonInt64Value(value: unknown): bigint | null {
  return officialBoundedInteger(value, -9223372036854775808n, 9223372036854775807n);
}

function item(value: LosslessJsonValue, consideration: boolean): boolean {
  if (!isJsonObject(value)) return false;
  const object = value as Record<string, LosslessJsonValue>;
  if (!own(object, "itemType") || officialJsonInt32Value(object.itemType) === null) return false;
  for (const key of ["token", "identifierOrCriteria", "startAmount", "endAmount"])
    if (!stringField(object, key)) return false;
  return !consideration || stringField(object, "recipient");
}

function price(value: LosslessJsonValue): boolean {
  if (!isJsonObject(value)) return false;
  const object = value as Record<string, LosslessJsonValue>;
  if (!own(object, "current") || !isJsonObject(object.current)) return false;
  const current = object.current as Record<string, LosslessJsonValue>;
  return stringField(current, "currency") && own(current, "decimals") &&
    officialJsonInt32Value(current.decimals) !== null && stringField(current, "value");
}

function parameters(value: LosslessJsonValue): boolean {
  if (!isJsonObject(value)) return false;
  const object = value as Record<string, LosslessJsonValue>;
  for (const key of ["offerer", "startTime", "endTime", "zone", "zoneHash", "salt", "conduitKey"])
    if (!stringField(object, key)) return false;
  for (const key of ["orderType", "totalOriginalConsiderationItems"])
    if (!own(object, key) || officialJsonInt32Value(object[key]) === null) return false;
  if (!own(object, "counter") || !isOfficialJsonInteger(object.counter)) return false;
  if (!Array.isArray(object.offer) || !Array.isArray(object.consideration)) return false;
  return object.offer.every((entry: LosslessJsonValue) => item(entry, false)) &&
    object.consideration.every((entry: LosslessJsonValue) => item(entry, true));
}

function protocolData(value: LosslessJsonValue): boolean {
  if (!isJsonObject(value)) return false;
  const object = value as Record<string, LosslessJsonValue>;
  return own(object, "parameters") && parameters(object.parameters);
}

function asset(value: LosslessJsonValue): boolean {
  return isJsonObject(value) && stringField(value, "contract") &&
    (!own(value, "identifier") || stringField(value, "identifier"));
}

/** Admission of the exact captured OpenAPI Listing schema consumed by OTG. */
export function validateOfficialListingRequired(order: Record<string, LosslessJsonValue>): boolean {
  for (const key of ["chain", "price", "remaining_quantity", "status", "type"])
    if (!own(order, key)) return false;
  if (!stringField(order, "chain") || !price(order.price) || officialJsonInt64Value(order.remaining_quantity) === null ||
      !stringField(order, "status") || !["ACTIVE", "INACTIVE", "FULFILLED", "EXPIRED", "CANCELLED"].includes(order.status as string) ||
      !stringField(order, "type")) return false;

  if (own(order, "order_hash") && !stringField(order, "order_hash")) return false;
  if (own(order, "protocol_address") && !stringField(order, "protocol_address")) return false;
  if (own(order, "protocol_data") && !protocolData(order.protocol_data)) return false;
  if (own(order, "asset") && !asset(order.asset)) return false;
  return true;
}
