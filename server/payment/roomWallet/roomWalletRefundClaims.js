/**
 * Refund transaction-hash uniqueness guard.
 *
 * One Room Wallet refund broadcast is one outgoing transfer obligation.
 * A single transaction hash must therefore never satisfy two distinct
 * payment-session participants. This helper is pure: it mutates only the
 * in-memory session objects supplied by the caller and never talks to TON or
 * persistence. The caller persists each returned affected session.
 */

function nonEmptyHash(value) {
    const hash = String(value ?? "").trim();
    return hash || null;
}

function obligationKey(session, participant, position) {
    return JSON.stringify([
        String(session?.paymentSessionId ?? session?.roomId ?? ""),
        String(participant?.playerId ?? ""),
        participant?.playerIndex == null ? position : Number(participant.playerIndex)
    ]);
}

function claimSnapshot(session, participant, txHash) {
    return Object.freeze({
        paymentSessionId: session?.paymentSessionId ?? null,
        roomId: session?.roomId ?? null,
        playerId: participant?.playerId ?? null,
        playerIndex: participant?.playerIndex ?? null,
        wallet: participant?.wallet ?? null,
        transactionHash: txHash,
        wasMarkedRefunded: participant?.refunded === true
    });
}

/**
 * Quarantine every participant claim involved in a duplicated transaction
 * hash. We deliberately do not pick a "winner": that requires external
 * forensic evidence. The original hash and participant identity are retained
 * in non-authoritative recovery metadata, while the ambiguous refunded flag
 * is cleared so restore cannot finalize the unwind or silently double-credit.
 *
 * @param {Array<object>} sessions hydrated PaymentSession-like objects
 * @param {{ now?: () => number }} options
 * @returns {Array<object>} unique affected session objects
 */
export function quarantineDuplicateRefundTxHashClaims(sessions, { now = () => Date.now() } = {}) {
    const claimsByHash = new Map();

    for (const session of Array.isArray(sessions) ? sessions : []) {
        for (const [position, participant] of (session?.participants ?? []).entries()) {
            const txHash = nonEmptyHash(participant?.refundTxHash);
            if (!txHash) {
                continue;
            }

            const key = obligationKey(session, participant, position);
            const claims = claimsByHash.get(txHash) ?? new Map();
            if (!claims.has(key)) {
                claims.set(key, {
                    session,
                    participant,
                    position,
                    key,
                    txHash,
                    snapshot: claimSnapshot(session, participant, txHash)
                });
            }
            claimsByHash.set(txHash, claims);
        }
    }

    const conflictsBySession = new Map();

    for (const [txHash, claimsMap] of claimsByHash.entries()) {
        const claims = [...claimsMap.values()];
        if (claims.length < 2) {
            continue;
        }

        const snapshots = claims.map((claim) => claim.snapshot);
        for (const claim of claims) {
            const sessionConflicts = conflictsBySession.get(claim.session) ?? [];
            sessionConflicts.push({
                transactionHash: txHash,
                claims: snapshots
            });
            conflictsBySession.set(claim.session, sessionConflicts);
            claim.participant.refunded = false;
            claim.participant.refundTxHash = null;
        }
    }

    const detectedAt = Number(now());
    const affected = [];

    for (const [session, conflicts] of conflictsBySession.entries()) {
        const existing = session.recoveryMetadata?.refundAttributionQuarantine;
        const previousConflicts = Array.isArray(existing?.conflicts)
            ? existing.conflicts
            : [];
        const dedupe = new Map();

        for (const conflict of [...previousConflicts, ...conflicts]) {
            const key = String(conflict?.transactionHash ?? "");
            if (key && !dedupe.has(key)) {
                dedupe.set(key, conflict);
            }
        }

        session.recoveryMetadata = {
            ...(session.recoveryMetadata ?? {}),
            refundAttributionQuarantine: {
                status: "MANUAL_RECONCILIATION_REQUIRED",
                reason: "DUPLICATE_TRANSACTION_HASH",
                detectedAt: existing?.detectedAt ?? detectedAt,
                conflicts: [...dedupe.values()]
            }
        };
        affected.push(session);
    }

    return affected;
}
