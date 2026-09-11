import type { TargetedVerifierContext } from "../../src/reconciliation/verifier/targetedVerifierTypes.js";

export function makeCanonicalOfficialOrder(context: TargetedVerifierContext, status = "ACTIVE"): Record<string, any> {
  const contract = context.contractAddress;
  const token = context.expectedIdentity.tokenId;
  const recipient = "0x" + "2".repeat(40);
  return {
    order_hash: context.orderHash,
    chain: context.chain,
    protocol_address: context.protocolAddress,
    status,
    type: "basic",
    price: { current: { currency: "ETH", decimals: 18, value: "1" } },
    asset: { contract, identifier: token },
    remaining_quantity: 1,
    protocol_data: { parameters: {
      offerer: recipient,
      offer: [{ itemType: 2, token: contract, identifierOrCriteria: token, startAmount: "1", endAmount: "1" }],
      consideration: [{ itemType: 2, token: contract, identifierOrCriteria: token, startAmount: "1", endAmount: "1", recipient }],
      startTime: "1893455000",
      endTime: "1893457000",
      orderType: 0,
      zone: "0x" + "3".repeat(40),
      zoneHash: "0x" + "0".repeat(64),
      salt: "1",
      conduitKey: "0x" + "0".repeat(64),
      totalOriginalConsiderationItems: 1,
      counter: 0,
    } },
  };
}

export function encodeCanonicalOrder(order: Record<string, any>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ order }));
}
