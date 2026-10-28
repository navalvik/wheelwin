import { createHash } from "node:crypto";

import { isAllowedBaseStake } from "../../models/PlayerProfileRules.js";
import { describeTonWalletIdentity } from "../../models/TonWalletAddress.js";
import { isPaymentReference } from "../incoming/PaymentReferenceCodec.js";

// All amounts are exact native TON nanoton units, displayed as GRAM by the UI.
// One sector costs 1x base stake; two sectors cost 2.5x base stake.
const HALF_GRAM_ATOMIC = 500_000_000;

/**
 * Construct payment intents from the three authoritative PlayerIdentity
 * records. A browser may register a payer address for its authenticated seat,
 * but it cannot supply the stake, reference, room roster or amount.
 *
 * Null means "not ready" and must never reserve a room wallet.
 */
export function buildAuthoritativeRoomPaymentRequests({ roomId, playerIds, playerManager }) {
    if (typeof roomId !== "string" || roomId.length === 0
        || !Array.isArray(playerIds) || playerIds.length !== 3
        || new Set(playerIds).size !== 3
        || playerIds.some((id) => typeof id !== "string" || id.length === 0)
        || typeof playerManager?.getIdentity !== "function") {
        return null;
    }

    const accounts = new Set();
    const references = new Set();
    const requests = [];

    for (const playerId of playerIds) {
        const identity = playerManager.getIdentity(playerId);
        const baseStake = identity?.baseStake;
        const sectorCount = identity?.sectorCount;
        if (!Number.isInteger(baseStake) || !isAllowedBaseStake(baseStake)
            || (sectorCount !== 1 && sectorCount !== 2)) {
            return null;
        }

        const payer = describeTonWalletIdentity(identity?.wallet, "testnet");
        if (!payer.address || !payer.accountId?.startsWith("0:")
            || accounts.has(payer.accountId)) {
            return null;
        }

        const amountAtomic = baseStake
            * (sectorCount === 2 ? 5 : 2) * HALF_GRAM_ATOMIC;
        if (!Number.isSafeInteger(amountAtomic) || amountAtomic <= 0) {
            return null;
        }

        const paymentReference = "WW-" + createHash("sha256")
            .update(roomId + ":" + playerId)
            .digest("hex").slice(0, 32);
        if (!isPaymentReference(paymentReference) || references.has(paymentReference)) {
            return null;
        }

        accounts.add(payer.accountId);
        references.add(paymentReference);
        requests.push({
            playerId,
            paymentReference,
            expectedSender: payer.address,
            amountAtomic
        });
    }

    return requests;
}
