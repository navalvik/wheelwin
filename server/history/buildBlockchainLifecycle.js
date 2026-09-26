/**
 * Unified financial lifecycle snapshot for session archive.
 * Room Wallet only: direct payments and winner settlement.
 */

const SECRET_KEY_RE = /mnemonic|privatekey|secretkey|private_key|secret_key/i;

function pushUniqueStage(stages, stage) {
    if (!stage || typeof stage !== "string" || stages.includes(stage)) return;
    stages.push(stage);
}

function scrubValue(value) {
    if (value == null) return value;
    if (typeof value === "string") return SECRET_KEY_RE.test(value) ? "[REDACTED]" : value;
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.map(scrubValue);
    if (typeof value === "object") {
        const out = {};
        for (const [key, nested] of Object.entries(value)) {
            if (SECRET_KEY_RE.test(key)) continue;
            out[key] = scrubValue(nested);
        }
        return out;
    }
    return String(value);
}

export function buildBlockchainLifecycle({
    settlementTrack = null,
    paymentConfirmationTrack = null
} = {}) {
    const settlementStages = [];
    for (const stage of settlementTrack?.stages ?? []) pushUniqueStage(settlementStages, stage);

    const settlement = Object.freeze({
        status: settlementTrack?.status ?? null,
        stages: Object.freeze([...settlementStages]),
        winnerWallet: settlementTrack?.winnerWallet ?? null,
        winnerAmount: settlementTrack?.winnerAmount ?? null,
        commissionWallet: settlementTrack?.commissionWallet ?? null,
        commissionAmount: settlementTrack?.commissionAmount ?? null,
        transactionHash: settlementTrack?.transactionHash ?? null,
        error: settlementTrack?.error ?? null
    });

    const paymentEvents = Array.isArray(paymentConfirmationTrack?.events)
        ? paymentConfirmationTrack.events.map((entry) => Object.freeze({ ...entry }))
        : [];

    const paymentConfirmation = Object.freeze({
        paidMask: paymentConfirmationTrack?.paidMask == null
            ? null
            : Number(paymentConfirmationTrack.paidMask),
        events: Object.freeze(paymentEvents)
    });

    return Object.freeze(scrubValue({ settlement, paymentConfirmation }));
}

export function createBlockchainTrack() {
    return {
        settlement: {
            stages: [],
            status: null,
            winnerWallet: null,
            winnerAmount: null,
            commissionWallet: null,
            commissionAmount: null,
            transactionHash: null,
            error: null
        },
        paymentConfirmation: {
            paidMask: null,
            events: []
        }
    };
}
