import { isJsonObject, jsonInt32, jsonIntegerToken, jsonString, type LosslessJsonValue } from "./losslessJson.js";

const has = (o: Record<string, LosslessJsonValue>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const str = (o: Record<string, LosslessJsonValue>, k: string) => has(o, k) && jsonString(o[k]) !== null;
const integer = (o: Record<string, LosslessJsonValue>, k: string) => has(o, k) && jsonIntegerToken(o[k]) !== null;

/** Admission-only validation of the effective official Listing/Parameters requirements. */
export function validateOfficialListingRequired(order: Record<string, LosslessJsonValue>): boolean {
  for (const k of ["chain", "price", "remaining_quantity", "status", "type", "asset", "protocol_data"]) if (!has(order, k)) return false;
  if (typeof order.chain !== "string" || !isJsonObject(order.price) || !isJsonObject(order.asset) || !isJsonObject(order.protocol_data)) return false;
  const pd = order.protocol_data as Record<string, LosslessJsonValue>;
  if (!has(pd, "parameters") || !isJsonObject(pd.parameters)) return false;
  const p = pd.parameters as Record<string, LosslessJsonValue>;
  for (const k of ["startTime", "endTime", "offerer", "zone", "zoneHash", "salt", "conduitKey"]) if (!str(p, k)) return false;
  for (const k of ["orderType", "totalOriginalConsiderationItems", "counter"]) if (!integer(p, k)) return false;
  if (!Array.isArray(p.offer) || !Array.isArray(p.consideration)) return false;
  for (const item of [...p.offer, ...p.consideration]) {
    if (!isJsonObject(item) || !str(item, "itemType") && !integer(item as Record<string, LosslessJsonValue>, "itemType")) return false;
  }
  return true;
}
