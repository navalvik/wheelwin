import {
    INCOMING_PRINCIPAL_CONFIRMATION_SOURCE,
    LEDGER_ENTRY_KIND
} from "../ledger/index.js";
import { PAYMENT_INTENT_STATE } from "../PaymentIntentStatus.js";

const REQUIRED_PLAYER_COUNT = 3;

function deny(reason) {
    return Object.freeze({ eligible: false, reason });
}

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate a persisted game-room payment snapshot before gameplay can start.
 * A SETTLED intent is only produced by the trusted settlement coordinator;
 * its matching principal entry records the accepted finalized-evidence path.
 */
export function assessThreePlayerPaymentGate({
    roomId,
    roomPlayerIds,
    network,
    asset,
    requirements,
    intents,
    principalEntries,
    nowMs = Date.now()
} = {}) {
    if (typeof roomId !== "string" || roomId.trim() === "") {
        return deny("invalid_room");
    }
    if (typeof network !== "string" || network.trim() === ""
        || typeof asset !== "string" || asset.trim() === "") {
        return deny("payment_denomination_unavailable");
    }
    if (!Array.isArray(roomPlayerIds) || roomPlayerIds.length !== REQUIRED_PLAYER_COUNT
        || roomPlayerIds.some((id) => typeof id !== "string" || id.trim() === "")
        || new Set(roomPlayerIds).size !== REQUIRED_PLAYER_COUNT) {
        return deny("room_must_have_three_distinct_players");
    }
    if (!Array.isArray(requirements) || requirements.length !== REQUIRED_PLAYER_COUNT
        || !Array.isArray(intents) || intents.length !== REQUIRED_PLAYER_COUNT
        || !Array.isArray(principalEntries)
        || !Number.isSafeInteger(nowMs) || nowMs <= 0) {
        return deny("payment_state_incomplete");
    }

    const roster = new Set(roomPlayerIds);
    const requirementByPlayer = new Map();
    const references = new Set();
    for (const requirement of requirements) {
        if (!isRecord(requirement)
            || requirement.roomId !== roomId
            || typeof requirement.playerId !== "string"
            || !roster.has(requirement.playerId)
            || typeof requirement.paymentReference !== "string"
            || requirement.paymentReference.trim() === ""
            || typeof requirement.expectedSender !== "string"
            || requirement.expectedSender.trim() === ""
            || !Number.isSafeInteger(requirement.amountAtomic)
            || requirement.amountAtomic <= 0
            || requirementByPlayer.has(requirement.playerId)
            || references.has(requirement.paymentReference)) {
            return deny("payment_requirements_do_not_match_room_roster");
        }
        requirementByPlayer.set(requirement.playerId, requirement);
        references.add(requirement.paymentReference);
    }
    if (requirementByPlayer.size !== REQUIRED_PLAYER_COUNT) {
        return deny("payment_requirements_do_not_match_room_roster");
    }

    const intentByReference = new Map();
    const transactionIds = new Set();
    for (const intent of intents) {
        if (!isRecord(intent)
            || intent.roomId !== roomId
            || intent.network !== network
            || intent.asset !== asset
            || !references.has(intent.paymentReference)
            || intent.state !== PAYMENT_INTENT_STATE.SETTLED
            || typeof intent.transactionId !== "string"
            || intent.transactionId.trim() === ""
            || !Number.isSafeInteger(intent.expiresAt)
            || nowMs >= intent.expiresAt
            || intentByReference.has(intent.paymentReference)
            || transactionIds.has(intent.transactionId)) {
            return deny("required_payment_not_settled_unambiguously");
        }
        const requirement = requirementByPlayer.get(intent.playerId);
        if (!requirement
            || requirement.playerId !== intent.playerId
            || requirement.paymentReference !== intent.paymentReference
            || requirement.expectedSender !== intent.expectedSender
            || requirement.amountAtomic !== intent.amountAtomic) {
            return deny("settled_intent_does_not_match_player_requirement");
        }
        intentByReference.set(intent.paymentReference, intent);
        transactionIds.add(intent.transactionId);
    }
    if (intentByReference.size !== REQUIRED_PLAYER_COUNT) {
        return deny("payment_state_incomplete");
    }

    const principalsByReference = new Map();
    for (const entry of principalEntries) {
        const reference = entry?.metadata?.paymentReference;
        if (references.has(reference)) {
            const matches = principalsByReference.get(reference) ?? [];
            matches.push(entry);
            principalsByReference.set(reference, matches);
        }
    }
    for (const requirement of requirements) {
        const intent = intentByReference.get(requirement.paymentReference);
        const entries = principalsByReference.get(requirement.paymentReference) ?? [];
        if (entries.length !== 1) {
            return deny("principal_record_missing_or_duplicated");
        }
        const entry = entries[0];
        if (entry.kind !== LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL
            || entry.roomId !== roomId
            || entry.network !== network
            || entry.asset !== asset
            || entry.playerId !== requirement.playerId
            || entry.amountAtomic !== requirement.amountAtomic
            || entry.metadata?.transactionId !== intent.transactionId
            || entry.metadata?.intentState !== PAYMENT_INTENT_STATE.SETTLED
            || entry.metadata?.source !== INCOMING_PRINCIPAL_CONFIRMATION_SOURCE) {
            return deny("principal_record_does_not_match_settled_payment");
        }
    }

    return Object.freeze({
        eligible: true,
        reason: null,
        roomId,
        playerIds: Object.freeze([...roomPlayerIds]),
        paymentReferences: Object.freeze(requirements.map((item) => item.paymentReference))
    });
}

export { REQUIRED_PLAYER_COUNT };
