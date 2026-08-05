/**
 * R7.19 — Temporary SetupSession._sessions storage forensics (diagnostics only).
 */

import { getLastDeployStage } from "./DeployPipelineForensics.js";

const _paymentReadyByRoom = new Set();

/**
 * @param {string} roomId
 */
export function registerSetupStoragePaymentReady(roomId) {

    if (roomId) {

        _paymentReadyByRoom.add(String(roomId));

    }

}

/**
 * @param {string} roomId
 * @returns {object}
 */
export function getSetupStorageStageContext(roomId) {

    const key = String(roomId ?? "");

    const deployEntry = getLastDeployStage(key);

    return {
        PaymentStage: _paymentReadyByRoom.has(key) ? "PAYMENT_STAGE_READY" : null,
        DeployStage: deployEntry?.stage ?? null
    };

}

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
export function logSetupStorageMutation(params) {

    _printBlock("SETUP STORAGE MUTATION", {
        Timestamp: new Date().toISOString(),
        Operation: params.operation,
        RoomId: params.roomId ?? null,
        CurrentState: params.currentState ?? null,
        Recoverable: params.recoverable ?? null,
        Caller: params.caller ?? null,
        Reason: params.reason ?? null,
        CurrentStage: params.currentStage ?? null,
        PaymentStage: params.paymentStage ?? null,
        DeployStage: params.deployStage ?? null,
        MapSizeBefore: params.mapSizeBefore ?? null,
        MapSizeAfter: params.mapSizeAfter ?? null
    });

}

/**
 * @param {object} params
 */
export function logSetupStorageMiss(params) {

    _printBlock("SETUP STORAGE MISS", {
        Timestamp: new Date().toISOString(),
        RoomId: params.roomId ?? null,
        Caller: params.caller ?? null,
        CurrentStage: params.currentStage ?? null,
        PaymentStage: params.paymentStage ?? null,
        DeployStage: params.deployStage ?? null,
        MapSize: params.mapSize ?? null,
        ExistingKeys: params.existingKeys ?? null
    });

}

/**
 * @param {object} params
 */
export function logSetupStorageDelete(params) {

    _printBlock("SETUP STORAGE DELETE", {
        Timestamp: new Date().toISOString(),
        RoomId: params.roomId ?? null,
        PreviousState: params.previousState ?? null,
        Recoverable: params.recoverable ?? null,
        Caller: params.caller ?? null,
        Reason: params.reason ?? null,
        CurrentStage: params.currentStage ?? null,
        DeployState: params.deployStage ?? null,
        MapSizeBefore: params.mapSizeBefore ?? null,
        MapSizeAfter: params.mapSizeAfter ?? null
    });

}

/**
 * @param {object} params
 */
export function logSetupStorageClear(params) {

    _printBlock("SETUP STORAGE CLEAR", {
        Timestamp: new Date().toISOString(),
        Caller: params.caller ?? null,
        Reason: params.reason ?? null,
        CurrentStage: params.currentStage ?? null,
        DeployState: params.deployStage ?? null,
        PreviousMapSize: params.previousMapSize ?? null
    });

}
