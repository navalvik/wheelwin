/**
 * Server-side Page4 payment requirements for exactly three verified Testnet
 * players. Uses only authoritative player identities (never client-supplied
 * payment amounts or references) and never sends a transaction.
 */
import { createHash } from "node:crypto";
import { deriveTonAddressIdentity } from "../incoming/TonAddressIdentity.js";
import { isAllowedBaseStake } from "../../models/PlayerProfileRules.js";

export function deriveTestnetRoomPaymentRequirements(roomId, playerIds, getIdentity) {
    if (typeof roomId !== "string" || !roomId
        || !Array.isArray(playerIds) || playerIds.length !== 3
        || new Set(playerIds).size !== 3
        || typeof getIdentity !== "function") return null;

    const identities = playerIds.map(id => getIdentity(id));
    const stake = identities[0]?.baseStake;
    if (!isAllowedBaseStake(stake) || !Number.isInteger(stake)
        || !identities.every(p => p && p.baseStake === stake
            && (p.sectorCount === 1 || p.sectorCount === 2))) return null;

    const requested = [];
    for (let i = 0; i < playerIds.length; i++) {
        const id = playerIds[i], identity = identities[i];
        if (identity.playerId !== id || typeof identity.wallet !== "string") return null;
        let sender;
        try {
            const canonical = deriveTonAddressIdentity(identity.wallet);
            if (!canonical.startsWith("0:")) return null;
            sender = canonical;
        } catch {
            return null;
        }
        const amountAtomic = stake * (identity.sectorCount === 2 ? 2_500_000_000 : 1_000_000_000);
        if (!Number.isSafeInteger(amountAtomic) || amountAtomic <= 0) return null;
        const reference = "WW_" + createHash("sha256")
            .update(JSON.stringify([roomId, id, sender]))
            .digest("hex").slice(0, 32);
        requested.push(Object.freeze({
            playerId: id,
            expectedSender: sender,
            amountAtomic,
            paymentReference: reference
        }));
    }
    return Object.freeze(requested);
}
