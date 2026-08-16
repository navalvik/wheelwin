/**
 * R17.8V.2P.M / P — Deployment reimbursement payload validation.
 */

import { createHash, randomUUID } from "node:crypto";

import {
    DEPLOYMENT_REIMBURSEMENT_STATUS,
    isDeploymentReimbursementStatus,
    isDeploymentReimbursementTerminal
} from "./deploymentReimbursementStates.js";

const REQUIRED_STRING_FIELDS = Object.freeze([
    "gameId",
    "roomId",
    "deploymentTxHash",
    "deployWallet",
    "reimbursementWallet",
    "deploymentCostSnapshotId",
    "amountTon"
]);

/**
 * @param {string} deploymentTxHash
 * @returns {string}
 */
export function deploymentReimbursementRecordId(deploymentTxHash) {

    return createHash("sha256")
        .update(`reimb:${String(deploymentTxHash ?? "")}`, "utf8")
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
export function validateDeploymentReimbursementCreateInput(input) {

    const errors = [];

    if (!input || typeof input !== "object") {

        return { ok: false, errors: ["input_missing"] };

    }

    for (const field of REQUIRED_STRING_FIELDS) {

        if (!isNonEmptyString(input[field])) {

            errors.push(`${field}_invalid`);

        }

    }

    if (
        isNonEmptyString(input.amountTon)
        && !/^\d+(\.\d+)?$/.test(String(input.amountTon).trim())
    ) {

        errors.push("amountTon_format_invalid");

    }

    const status = input.status ?? DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING;

    if (!isDeploymentReimbursementStatus(status)) {

        errors.push("status_invalid");

    }

    if (status !== DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING) {

        errors.push("status_must_be_pending_on_create");

    }

    if (errors.length > 0) {

        return { ok: false, errors };

    }

    const deploymentTxHash = String(input.deploymentTxHash).trim();
    const id = deploymentReimbursementRecordId(deploymentTxHash);
    const createdAt = Number.isFinite(Number(input.createdAt))
        ? Number(input.createdAt)
        : Date.now();

    const payload = Object.freeze({
        id,
        gameId: String(input.gameId).trim(),
        roomId: String(input.roomId).trim(),
        contractId: isNonEmptyString(input.contractId)
            ? String(input.contractId).trim()
            : null,
        deploymentTxHash,
        deployWallet: String(input.deployWallet).trim(),
        reimbursementWallet: String(input.reimbursementWallet).trim(),
        deploymentCostSnapshotId: String(input.deploymentCostSnapshotId).trim(),
        amountTon: String(input.amountTon).trim(),
        status,
        createdAt,
        processedAt: null,
        confirmedAt: null,
        txHash: null,
        retryCount: 0,
        nextRetryAt: null,
        errorReason: null,
        confirmationAttempts: 0,
        nextConfirmationAt: null,
        confirmationError: null
    });

    return { ok: true, payload };

}

/**
 * @param {object} existingPayload
 * @param {object} patch
 * @returns {{ ok: true, payload: object } | { ok: false, errors: string[] }}
 */
export function applyDeploymentReimbursementStatusPatch(existingPayload, patch) {

    if (!existingPayload || typeof existingPayload !== "object") {

        return { ok: false, errors: ["existing_missing"] };

    }

    if (isDeploymentReimbursementTerminal(existingPayload.status)) {

        return { ok: false, errors: ["reimbursement_terminal"] };

    }

    if (!patch || typeof patch !== "object") {

        return { ok: false, errors: ["patch_missing"] };

    }

    const nextStatus = patch.status ?? existingPayload.status;

    if (!isDeploymentReimbursementStatus(nextStatus)) {

        return { ok: false, errors: ["status_invalid"] };

    }

    // Stage P: CONFIRMED only from PROCESSING with an on-chain txHash.
    if (nextStatus === DEPLOYMENT_REIMBURSEMENT_STATUS.CONFIRMED) {

        const txHash = patch.txHash !== undefined
            ? patch.txHash
            : existingPayload.txHash;

        if (
            existingPayload.status !== DEPLOYMENT_REIMBURSEMENT_STATUS.PROCESSING
            || !isNonEmptyString(txHash)
        ) {

            return { ok: false, errors: ["confirmed_requires_processing_txhash"] };

        }

    }

    const payload = Object.freeze({
        ...existingPayload,
        status: nextStatus,
        processedAt: patch.processedAt !== undefined
            ? patch.processedAt
            : existingPayload.processedAt,
        confirmedAt: patch.confirmedAt !== undefined
            ? patch.confirmedAt
            : (
                nextStatus === DEPLOYMENT_REIMBURSEMENT_STATUS.CONFIRMED
                    ? (existingPayload.confirmedAt ?? Date.now())
                    : existingPayload.confirmedAt
            ),
        txHash: patch.txHash !== undefined
            ? patch.txHash
            : existingPayload.txHash,
        retryCount: patch.retryCount !== undefined
            ? Number(patch.retryCount)
            : existingPayload.retryCount,
        nextRetryAt: patch.nextRetryAt !== undefined
            ? patch.nextRetryAt
            : existingPayload.nextRetryAt,
        errorReason: patch.errorReason !== undefined
            ? patch.errorReason
            : existingPayload.errorReason,
        confirmationAttempts: patch.confirmationAttempts !== undefined
            ? Number(patch.confirmationAttempts)
            : (existingPayload.confirmationAttempts ?? 0),
        nextConfirmationAt: patch.nextConfirmationAt !== undefined
            ? patch.nextConfirmationAt
            : (existingPayload.nextConfirmationAt ?? null),
        confirmationError: patch.confirmationError !== undefined
            ? patch.confirmationError
            : (existingPayload.confirmationError ?? null)
    });

    return { ok: true, payload };

}

/**
 * @returns {string}
 */
export function generateDeploymentReimbursementCorrelationId() {

    return `dr_${randomUUID()}`;

}
