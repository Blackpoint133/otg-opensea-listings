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
                if (typeof order.remaining_quantity === "string" && /^\d+$/.test(order.remaining_quantity)) order.remaining_quantity = Number(order.remaining_quantity);
                const offer = "offer" in p ? p.offer : [{
                        itemType: 2, token: order.asset?.contract, identifierOrCriteria: order.asset?.identifier,
                        startAmount: "1", endAmount: "1"
                    }];
                const renameItem = (v: any) => !v || typeof v !== "object" ? v : ({
                    itemType: v.itemType ?? v.item_type, token: v.token, identifierOrCriteria: v.identifierOrCriteria ?? v.identifier_or_criteria,
                    startAmount: v.startAmount ?? v.start_amount, endAmount: v.endAmount ?? v.end_amount
                });
                order.protocol_data = { parameters: {
                        ...p, startTime: p.startTime ?? p.start_time, endTime: p.endTime ?? p.end_time,
                        orderType: order.order_type ?? p.orderType ?? p.order_type ?? 0,
                        offer: Array.isArray(offer) ? offer.map(renameItem) : offer
                    } };
                if (typeof order.remaining_quantity === "string" && /^(0|[1-9][0-9]*)$/.test(order.remaining_quantity)) order.remaining_quantity = Number(order.remaining_quantity);
                delete order.protocol_data.parameters.start_time;
                delete order.protocol_data.parameters.end_time;
                delete order.protocol_data.parameters.order_type;
            }
            body = new TextEncoder().encode(JSON.stringify({ order }));
        }
    }
    catch { /* Malformed synthetic bytes are forwarded unchanged. */ }
    const at = input.observedAt ?? null;
    const validDate = at !== null && Number.isFinite(Date.parse(at));
    const observation = adaptOpenSeaExactOrder({
        context: input.context, httpStatus: input.httpStatus, transportOutcome: input.transportOutcome,
        body, timing: validDate ? { requestStartedAt: at!, responseHeadersAt: at!, responseCompletedAt: at!, elapsedMs: 10, overallDeadlineMs: 1000, deadlineExceeded: false } : undefined,
        headers: [{ name: "Content-Type", value: "application/json" },
            ...(validDate ? [{ name: "Date", value: new Date(at!).toUTCString() }] : [])]
    });
    return interpretOpenSeaExactOrderObservation({ context: input.context, observation });
}
