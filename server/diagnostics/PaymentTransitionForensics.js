/**
 * R7.20 — Temporary VERIFY → PAYMENT transition forensics (diagnostics only).
 */

import { getLastDeployStage } from "./DeployPipelineForensics.js";

/**
 * @param {string} title
 * @param {Record<string, unknown>} fields
 */
function _printBlock(title, fields) {

    console.log("======================================================");
    console.log(title);

    for (const [key, value] of Object.entries(fields)) {

        console.log(`${key}:`, value);

    }

    console.trace();
    console.log("======================================================");

}

/**
 * @param {object} params
 */
export function logPaymentTransitionGate(params) {

    _printBlock("PAYMENT TRANSITION GATE", {
        Timestamp: new Date().toISOString(),
        RoomId: params.roomId ?? null,
        CurrentStage: params.currentStage ?? null,
        SetupExists: params.setupExists ?? null,
        SetupState: params.setupState ?? null,
        Recoverable: params.recoverable ?? null,
        archiveForPaymentResult: params.archiveForPaymentResult ?? null,
        RoomExists: params.roomExists ?? null,
        RoomDestroying: params.roomDestroying ?? null,
        VerifiedPlayers: params.verifiedPlayers ?? null,
        WalletReady: params.walletReady ?? null,
        WillEmitPAYMENT_STAGE_READY: params.willEmitPaymentStageReady ?? null,
        Caller: params.caller ?? null
    });

}

/**
 * @param {object} params
 */
export function logPaymentStageReady(params) {

    const deployEntry = getLastDeployStage(params.roomId);

    _printBlock("PAYMENT STAGE READY", {
        Timestamp: new Date().toISOString(),
        RoomId: params.roomId ?? null,
        archiveForPaymentResult: params.archiveForPaymentResult ?? null,
        SetupState: params.setupState ?? null,
        Recoverable: params.recoverable ?? null,
        CurrentStage: params.currentStage ?? null,
        RoomDestroying: params.roomDestroying ?? null,
        DeployStage: deployEntry?.stage ?? null,
        EmissionTarget: params.emissionTarget ?? "room"
    });

}

/**
 * @param {object} params
 */
export function logPaymentTransitionFailure(params) {

    _printBlock("PAYMENT TRANSITION FAILURE", {
        Timestamp: new Date().toISOString(),
        RoomId: params.roomId ?? null,
        Reason: params.reason ?? null,
        CurrentSetupState: params.currentSetupState ?? null,
        Recoverable: params.recoverable ?? null,
        Caller: params.caller ?? null,
        WillContinueTransition: params.willContinueTransition ?? null
    });

}
