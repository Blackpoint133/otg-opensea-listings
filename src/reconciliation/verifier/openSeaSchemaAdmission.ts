import { isJsonObject, jsonInt32, jsonIntegerToken, jsonString, type LosslessJsonValue } from "./losslessJson.js";

const own = (o: Record<string, LosslessJsonValue>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const stringField = (o: Record<string, LosslessJsonValue>, k: string) => own(o, k) && jsonString(o[k]) !== null;
const integerField = (o: Record<string, LosslessJsonValue>, k: string) => own(o, k) && jsonIntegerToken(o[k]) !== null;

function item(value: LosslessJsonValue, consideration: boolean): boolean {
  if (!isJsonObject(value) || !integerField(value, "itemType")) return false;
  for (const key of ["token", "identifierOrCriteria", "startAmount", "endAmount"])
    if (!stringField(value, key)) return false;
  return !consideration || stringField(value, "recipient");
}

function price(value: LosslessJsonValue): boolean {
  if (!isJsonObject(value)) return false;
  if (!Object.prototype.hasOwnProperty.call(value, "current")) return true;
  const current = (value as Record<string, LosslessJsonValue>).current;
  return isJsonObject(current) && stringField(current, "currency") &&
    integerField(current, "decimals") && stringField(current, "value");
}

/** Admission of the effective required shape of the official Listing branch. */
export function validateOfficialListingRequired(order: Record<string, LosslessJsonValue>): boolean {
  const required = ["order_hash", "chain", "protocol_data", "protocol_address", "asset", "price", "remaining_quantity", "status", "type"];
  if (required.some((key) => !own(order, key))) return false;
  if (!stringField(order, "order_hash") || !stringField(order, "chain") || !stringField(order, "protocol_address") ||
      !stringField(order, "status") || !stringField(order, "type") || !integerField(order, "remaining_quantity") ||
      !price(order.price) || !isJsonObject(order.asset) || !isJsonObject(order.protocol_data)) return false;
  if (!stringField(order.asset, "contract") || (own(order.asset, "identifier") && !stringField(order.asset, "identifier"))) return false;
  const protocolData = order.protocol_data as Record<string, LosslessJsonValue>;
  if (!isJsonObject(protocolData.parameters)) return false;
  const parameters = protocolData.parameters as Record<string, LosslessJsonValue>;
  for (const key of ["offerer", "startTime", "endTime", "zone", "zoneHash", "salt", "conduitKey"])
    if (!stringField(parameters, key)) return false;
  for (const key of ["orderType", "totalOriginalConsiderationItems"])
    if (jsonInt32(parameters[key]) === null) return false;
  if (!integerField(parameters, "counter")) return false;
  if (!Array.isArray(parameters.offer) || !Array.isArray(parameters.consideration) || parameters.offer.length === 0 || parameters.consideration.length === 0) return false;
  return (parameters.offer as LosslessJsonValue[]).every((entry: LosslessJsonValue) => item(entry, false)) && (parameters.consideration as LosslessJsonValue[]).every((entry: LosslessJsonValue) => item(entry, true));
}
