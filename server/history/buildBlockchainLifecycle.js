/**
 * R7.57 — Unified blockchain lifecycle snapshot for session archive.
 * Diagnostics only. Never accepts or copies mnemonic / privateKey / secretKey.
 */

const SECRET_KEY_RE = /mnemonic|privatekey|secretkey|private_key|secret_key/i;

function pushUniqueStage(stages, stage) {

    if (!stage || typeof stage !== "string") {

        return;

    }

    if (stages.includes(stage)) {

        return;

    }

    stages.push(stage);

}

function scrubValue(value) {

    if (value == null) {

        return value;

    }

    if (typeof value === "string") {

        return SECRET_KEY_RE.test(value) ? "[REDACTED]" : value;

    }

    if (typeof value === "number" || typeof value === "boolean") {

        return value;

    }

    if (Array.isArray(value)) {

        return value.map((entry) => scrubValue(entry));

    }

    if (typeof value === "object") {

        const out = {};

        for (const [key, nested] of Object.entries(value)) {

            if (SECRET_KEY_RE.test(key)) {

                continue;

            }

            out[key] = scrubValue(nested);

        }

        return out;

    }

    return String(value);

}

/**
 * @param {{
 *   tonDeployDebug?: object|null,
 *   deployTrack?: object|null,
 *   settlementTrack?: object|null
 * }} input
 * @returns {{ deploy: object, settlement: object }}
 */
export function buildBlockchainLifecycle({
    tonDeployDebug = null,
    deployTrack = null,
    settlementTrack = null
} = {}) {

    const deployStages = [];

    if (deployTrack?.began === true || tonDeployDebug?.deployStarted === true) {

        pushUniqueStage(deployStages, "BEGIN_DEPLOY");

    }

    for (const stage of deployTrack?.stages ?? []) {

        pushUniqueStage(deployStages, stage);

    }

    for (const stage of tonDeployDebug?.stage ?? []) {

        if (stage === "START") {

            continue;

        }

        pushUniqueStage(deployStages, stage);

    }

    const deployAttempted = deployStages.length > 0
        || Boolean(tonDeployDebug)
        || deployTrack?.began === true;

    if (deployAttempted) {

        pushUniqueStage(deployStages, "DEPLOY_RESULT");

    }

    let deployStatus = deployTrack?.status ?? null;

    if (!deployStatus && tonDeployDebug) {

        if (tonDeployDebug.errorMessage || tonDeployDebug.currentStage === "FAILED") {

            deployStatus = "FAILED";

        } else if (
            tonDeployDebug.stage?.includes("BOC_SEND_SUCCESS")
            || tonDeployDebug.stage?.includes("BROADCAST_SENT")
        ) {

            deployStatus = "SUCCESS";

        } else {

            deployStatus = tonDeployDebug.currentStage ?? "IN_PROGRESS";

        }

    }

    if (!deployStatus && deployAttempted) {

        deployStatus = "UNKNOWN";

    }

    const deployError = deployTrack?.error
        ?? tonDeployDebug?.errorMessage
        ?? null;

    const deploy = Object.freeze({
        status: deployStatus,
        stages: Object.freeze([...deployStages]),
        contractAddress: deployTrack?.contractAddress
            ?? tonDeployDebug?.escrowAddress
            ?? null,
        transactionHash: deployTrack?.transactionHash ?? null,
        error: deployError
    });

    const settlementStages = [];

    for (const stage of settlementTrack?.stages ?? []) {

        pushUniqueStage(settlementStages, stage);

    }

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

    return Object.freeze(scrubValue({
        deploy,
        settlement
    }));

}

/**
 * Empty forensic track attached to a pending archive session.
 * @returns {{ deploy: object, settlement: object }}
 */
export function createBlockchainTrack() {

    return {
        deploy: {
            began: false,
            stages: [],
            status: null,
            contractAddress: null,
            transactionHash: null,
            error: null
        },
        settlement: {
            stages: [],
            status: null,
            winnerWallet: null,
            winnerAmount: null,
            commissionWallet: null,
            commissionAmount: null,
            transactionHash: null,
            error: null
        }
    };

}
