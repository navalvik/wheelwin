/**
 * R17.8V.2P.H — Deployment cost snapshot payload validation (persistence only).
 *
 * Does not calculate deploymentCostTon. Amount fields may be null at Stage A.
 */

import { createHash, randomUUID } from "node:crypto";

import {
    DEPLOYMENT_COST_SNAPSHOT_STATUS,
    isDeploymentCostSnapshotStatus
} from "./deploymentCostSnapshotStates.js";

const REQUIRED_STRING_FIELDS = Object.freeze([
    "gameId",
    "roomId",
    "contractId",
    "contractAddress",
    "deploymentTxHash",
    "deployWallet"
]);

/**
 * Filesystem-safe record id (deploymentTxHash may contain `/` `=`).
 *
 * @param {string} deploymentTxHash
 * @returns {string}
 */
export function deploymentCostSnapshotRecordId(deploymentTxHash) {

    return createHash("sha256")
        .update(String(deploymentTxHash ?? ""), "utf8")
        .digest("hex");

}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {

    return typeof value === "string" && value.trim().length > 0;

}

/**
 * @param {object} input
 * @returns {{ ok: true, payload: object } | { ok: false, errors: string[] }}
 */
export function validateDeploymentCostSnapshotCreateInput(input) {

    const errors = [];

    if (!input || typeof input !== "object") {

        return { ok: false, errors: ["input_missing"] };

    }

    for (const field of REQUIRED_STRING_FIELDS) {

        if (!isNonEmptyString(input[field])) {

            errors.push(`${field}_invalid`);

        }

    }

    const status = input.status ?? DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP;

    if (!isDeploymentCostSnapshotStatus(status)) {

        errors.push("status_invalid");

    }

    if (
        status === DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN
    ) {

        // Stage A create path must not invent frozen economics.
        errors.push("status_frozen_not_allowed_on_create");

    }

    if (errors.length > 0) {

        return { ok: false, errors };

    }

    const deploymentTxHash = String(input.deploymentTxHash).trim();
    const id = deploymentCostSnapshotRecordId(deploymentTxHash);

    const createdAt = Number.isFinite(Number(input.createdAt))
        ? Number(input.createdAt)
        : Date.now();

    const payload = Object.freeze({
        id,
        gameId: String(input.gameId).trim(),
        roomId: String(input.roomId).trim(),
        contractId: String(input.contractId).trim(),
        contractAddress: String(input.contractAddress).trim(),
        deploymentTxHash,
        deployWallet: String(input.deployWallet).trim(),
        status,
        createdAt,
        attachedTon: input.attachedTon ?? null,
        networkFeeTon: input.networkFeeTon ?? null,
        deploymentCostTon: input.deploymentCostTon ?? null,
        source: input.source ?? null,
        frozenAt: input.frozenAt ?? null,
        errorReason: input.errorReason ?? null,
        lookupAttempts: Number.isFinite(Number(input.lookupAttempts))
            ? Number(input.lookupAttempts)
            : 0,
        nextLookupAt: input.nextLookupAt ?? null
    });

    return { ok: true, payload };

}

/**
 * Patch allowed for non-frozen Stage A updates (lookup bookkeeping only).
 * Amount / freeze fields are reserved for later stages.
 *
 * @param {object} existingPayload
 * @param {object} patch
 * @returns {{ ok: true, payload: object } | { ok: false, errors: string[] }}
 */
export function applyDeploymentCostSnapshotPendingPatch(existingPayload, patch) {

    if (!existingPayload || typeof existingPayload !== "object") {

        return { ok: false, errors: ["existing_missing"] };

    }

    if (
        existingPayload.status === DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN
    ) {

        return { ok: false, errors: ["snapshot_frozen"] };

    }

    if (!patch || typeof patch !== "object") {

        return { ok: false, errors: ["patch_missing"] };

    }

    const nextStatus = patch.status ?? existingPayload.status;

    if (!isDeploymentCostSnapshotStatus(nextStatus)) {

        return { ok: false, errors: ["status_invalid"] };

    }

    if (nextStatus === DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN) {

        return { ok: false, errors: ["freeze_not_allowed_stage_a"] };

    }

    const forbiddenAmountKeys = [
        "attachedTon",
        "networkFeeTon",
        "deploymentCostTon",
        "frozenAt",
        "source"
    ];

    for (const key of forbiddenAmountKeys) {

        if (Object.prototype.hasOwnProperty.call(patch, key)) {

            return { ok: false, errors: [`${key}_not_allowed_stage_a`] };

        }

    }

    const payload = Object.freeze({
        ...existingPayload,
        status: nextStatus,
        errorReason: patch.errorReason !== undefined
            ? patch.errorReason
            : existingPayload.errorReason,
        lookupAttempts: patch.lookupAttempts !== undefined
            ? Number(patch.lookupAttempts)
            : existingPayload.lookupAttempts,
        nextLookupAt: patch.nextLookupAt !== undefined
            ? patch.nextLookupAt
            : existingPayload.nextLookupAt
    });

    return { ok: true, payload };

}

/**
 * @returns {string}
 */
export function generateDeploymentCostSnapshotCorrelationId() {

    return `dcs_${randomUUID()}`;

}
