import { adaptOpenSeaExactOrder } from "../../src/reconciliation/verifier/openSeaExactOrderAdapter.js";
import { interpretOpenSeaExactOrderObservation } from "../../src/reconciliation/verifier/targetedVerifierNormalizer.js";
import type { TargetedVerifierContext, TransportOutcome } from "../../src/reconciliation/verifier/targetedVerifierTypes.js";
/** Test shorthand only. Runtime proof always comes from the real adapter/normalizer. */
export function providerFixture(input: {
    context: TargetedVerifierContext;
    httpStatus: number | null;
    rawBody?: string;
    observedAt?: string | null;
    transportOutcome?: TransportOutcome;
}) {
    let body = input.rawBody === undefined ? null : new TextEncoder().encode(input.rawBody);
    try {
        const order = JSON.parse(input.rawBody ?? "");
        if (order && typeof order === "object" && !Array.isArray(order) && !("order" in order)) {
            const p = order.protocol_data?.parameters;
            if (p && typeof p === "object") {
                const offer = "offer" in p ? p.offer : [{
                        itemType: 2, token: order.asset?.contract, identifierOrCriteria: order.asset?.identifier,
                        startAmount: "1", endAmount: "1"
                    }];
                const renameItem = (v: any) => !v || typeof v !== "object" ? v : ({
                    item_type: v.itemType, token: v.token, identifier_or_criteria: v.identifierOrCriteria,
                    start_amount: v.startAmount, end_amount: v.endAmount
                });
                order.protocol_data = { parameters: {
                        ...p, start_time: p.startTime, end_time: p.endTime,
                        order_type: order.order_type ?? p.orderType ?? 0,
                        offer: Array.isArray(offer) ? offer.map(renameItem) : offer
                    } };
                delete order.protocol_data.parameters.startTime;
                delete order.protocol_data.parameters.endTime;
                delete order.protocol_data.parameters.orderType;
            }
            body = new TextEncoder().encode(JSON.stringify({ order }));
        }
    }
    catch { /* Malformed synthetic bytes are forwarded unchanged. */ }
    const at = input.observedAt ?? null;
    const validDate = at !== null && Number.isFinite(Date.parse(at));
    const observation = adaptOpenSeaExactOrder({
        context: input.context, httpStatus: input.httpStatus, transportOutcome: input.transportOutcome,
        body, requestStartedAt: at ?? undefined, responseHeadersAt: at ?? undefined,
        responseCompletedAt: at ?? undefined,
        headers: [{ name: "Content-Type", value: "application/json" },
            ...(validDate ? [{ name: "Date", value: new Date(at!).toUTCString() }] : [])]
    });
    return interpretOpenSeaExactOrderObservation({ context: input.context, observation });
}
