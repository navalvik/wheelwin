/**
 * R17.8V.2P.O / Q — Reimbursement transfer service (secure TON send boundary).
 *
 * Policy + wallet balance gates → adapter → SENT / AWAITING_TRANSACTION_HASH / FAILED.
 * Never invents synthetic txHash. Never marks CONFIRMED.
 */

import { DEPLOYMENT_COST_SNAPSHOT_STATUS } from "./deploymentCostSnapshotStates.js";
import {
    getReimbursementMaxTransferTon,
    isReimbursementSendAllowed,
    reimbursementAddressesEqual
} from "./ReimbursementWalletConfig.js";
import { ReimbursementPolicy, REIMBURSEMENT_POLICY_RESULT } from "./ReimbursementPolicy.js";
import {
    REIMBURSEMENT_WALLET_MONITOR_RESULT
} from "./ReimbursementWalletMonitor.js";
import { tonStringToNanoton } from "./nanoton.js";

export const REIMBURSEMENT_TRANSFER_RESULT = Object.freeze({
    SENT: "SENT",
    AWAITING_TRANSACTION_HASH: "AWAITING_TRANSACTION_HASH",
    FAILED: "FAILED",
    FEATURE_DISABLED: "FEATURE_DISABLED",
    NOT_INITIALIZED: "NOT_INITIALIZED",
    VALIDATION_FAILED: "VALIDATION_FAILED",
    AMOUNT_INVALID: "AMOUNT_INVALID",
    AMOUNT_EXCEEDS_MAX: "AMOUNT_EXCEEDS_MAX",
    DAILY_LIMIT_REACHED: "DAILY_LIMIT_REACHED",
    INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
    DESTINATION_INVALID: "DESTINATION_INVALID",
    DESTINATION_MISMATCH: "DESTINATION_MISMATCH",
    WALLET_DISABLED: "WALLET_DISABLED"
});

export class ReimbursementTransferService {

    /**
     * @param {{
     *   adapter?: import("./ReimbursementWalletAdapter.js").ReimbursementWalletAdapter|null,
     *   snapshotRepository?: import("./DeploymentCostSnapshotRepository.js").DeploymentCostSnapshotRepository|null,
     *   policy?: import("./ReimbursementPolicy.js").ReimbursementPolicy|null,
     *   walletMonitor?: import("./ReimbursementWalletMonitor.js").ReimbursementWalletMonitor|null,
     *   logger?: object|null,
     *   env?: NodeJS.ProcessEnv
     * }} [options]
     */
    constructor({
        adapter = null,
        snapshotRepository = null,
        policy = null,
        walletMonitor = null,
        logger = null,
        env = process.env
    } = {}) {

        this._adapter = adapter;
        this._snapshotRepository = snapshotRepository;
        this._policy = policy;
        this._walletMonitor = walletMonitor;
        this._logger = logger;
        this._env = env;
        this._initialized = false;

    }

    /**
     * @returns {Promise<void>}
     */
    async initialize() {

        this._initialized = true;

        if (!isReimbursementSendAllowed(this._env)) {

            this._logger?.debug?.(
                "ReimbursementTransferService initialized (sends disabled)"
            );

            return;

        }

        if (this._adapter?.initialize) {

            const result = await this._adapter.initialize();

            if (!result?.ok) {

                this._logger?.warn?.(
                    `ReimbursementTransferService wallet init deferred failure | `
                        + `${result?.code ?? result?.message ?? "unknown"}`
                );

            }

        }

        this._logger?.debug?.(
            "ReimbursementTransferService initialized (Stage Q safety gates)"
        );

    }

    shutdown() {

        this._adapter?.shutdown?.();
        this._initialized = false;

    }

    /**
     * @param {object} record financial envelope or payload
     * @returns {Promise<object>}
     */
    async sendReimbursement(record) {

        if (!this._initialized) {

            return {
                ok: false,
                code: REIMBURSEMENT_TRANSFER_RESULT.NOT_INITIALIZED,
                txHash: null,
                errorReason: "transfer_service_not_initialized"
            };

        }

        const policyGate = this._policy?.validateWalletPolicy?.()
            ?? (
                isReimbursementSendAllowed(this._env)
                    ? { ok: true }
                    : {
                        ok: false,
                        code: REIMBURSEMENT_POLICY_RESULT.FEATURE_DISABLED,
                        reason: "reimbursement_send_disabled"
                    }
            );

        if (!policyGate.ok) {

            return {
                ok: false,
                code: REIMBURSEMENT_TRANSFER_RESULT.FEATURE_DISABLED,
                txHash: null,
                errorReason: policyGate.reason ?? "reimbursement_send_disabled"
            };

        }

        const validation = this._validateTransferRequest(record);

        if (!validation.ok) {

            return {
                ok: false,
                code: validation.code,
                txHash: null,
                errorReason: validation.errorReason,
                message: validation.message
            };

        }

        const recordId = record?.recordId ?? record?.payload?.id ?? null;

        const single = this._policy?.validateSingleTransfer?.(validation.amountTon)
            ?? { ok: true };

        if (!single.ok) {

            return {
                ok: false,
                code: mapPolicyCode(single.code),
                txHash: null,
                errorReason: single.reason ?? single.code
            };

        }

        const daily = this._policy?.validateDailyLimit?.({
            amountTon: validation.amountTon,
            excludeRecordId: recordId
        }) ?? { ok: true };

        if (!daily.ok) {

            return {
                ok: false,
                code: mapPolicyCode(daily.code),
                txHash: null,
                errorReason: daily.reason ?? daily.code
            };

        }

        if (this._walletMonitor?.validateAvailableBalance) {

            const balance = await this._walletMonitor.validateAvailableBalance(
                validation.amountTon
            );

            if (!balance.ok) {

                return {
                    ok: false,
                    code: balance.code
                        === REIMBURSEMENT_WALLET_MONITOR_RESULT.INSUFFICIENT_BALANCE
                        ? REIMBURSEMENT_TRANSFER_RESULT.INSUFFICIENT_BALANCE
                        : REIMBURSEMENT_TRANSFER_RESULT.FAILED,
                    txHash: null,
                    errorReason: balance.reason ?? balance.code
                };

            }

        }

        if (!this._adapter?.sendTransfer) {

            return {
                ok: false,
                code: REIMBURSEMENT_TRANSFER_RESULT.FAILED,
                txHash: null,
                errorReason: "wallet_adapter_missing"
            };

        }

        const sent = await this._adapter.sendTransfer({
            destination: validation.destination,
            amountTon: validation.amountTon
        });

        if (
            sent?.ok
            && sent.code === REIMBURSEMENT_TRANSFER_RESULT.AWAITING_TRANSACTION_HASH
        ) {

            return {
                ok: true,
                code: REIMBURSEMENT_TRANSFER_RESULT.AWAITING_TRANSACTION_HASH,
                txHash: null,
                seqno: sent.seqno ?? null,
                errorReason: null
            };

        }

        if (sent?.ok && sent.code === REIMBURSEMENT_TRANSFER_RESULT.SENT) {

            const txHash = String(sent.txHash ?? "").trim();

            if (!txHash || /^reimb_seqno_/i.test(txHash)) {

                return {
                    ok: true,
                    code: REIMBURSEMENT_TRANSFER_RESULT.AWAITING_TRANSACTION_HASH,
                    txHash: null,
                    seqno: sent.seqno ?? null,
                    errorReason: null
                };

            }

            return {
                ok: true,
                code: REIMBURSEMENT_TRANSFER_RESULT.SENT,
                txHash,
                errorReason: null
            };

        }

        return {
            ok: false,
            code: REIMBURSEMENT_TRANSFER_RESULT.FAILED,
            txHash: null,
            errorReason: sent?.errorReason
                ?? sent?.code
                ?? "transfer_failed"
        };

    }

    /**
     * @param {object} record
     * @returns {object}
     */
    _validateTransferRequest(record) {

        const payload = record?.payload ?? record;

        if (!payload || typeof payload !== "object") {

            return {
                ok: false,
                code: REIMBURSEMENT_TRANSFER_RESULT.VALIDATION_FAILED,
                errorReason: "record_missing",
                message: "Reimbursement record missing"
            };

        }

        const destination = String(payload.deployWallet ?? "").trim();
        const amountTon = String(payload.amountTon ?? "").trim();
        const gameId = String(payload.gameId ?? "").trim();
        const reimbursementWallet = String(payload.reimbursementWallet ?? "").trim();

        if (!destination) {

            return {
                ok: false,
                code: REIMBURSEMENT_TRANSFER_RESULT.DESTINATION_INVALID,
                errorReason: "missing_deploy_wallet"
            };

        }

        const amountNano = tonStringToNanoton(amountTon);

        if (amountNano == null || amountNano <= 0n) {

            return {
                ok: false,
                code: REIMBURSEMENT_TRANSFER_RESULT.AMOUNT_INVALID,
                errorReason: "amount_not_positive"
            };

        }

        const maxTon = getReimbursementMaxTransferTon(this._env);
        const maxNano = tonStringToNanoton(maxTon);

        if (maxNano == null || amountNano > maxNano) {

            return {
                ok: false,
                code: REIMBURSEMENT_TRANSFER_RESULT.AMOUNT_EXCEEDS_MAX,
                errorReason: `amount_exceeds_max_${maxTon}`
            };

        }

        if (this._adapter?.getAddress?.()) {

            const source = this._adapter.getAddress();

            if (
                reimbursementWallet
                && !reimbursementAddressesEqual(source, reimbursementWallet)
            ) {

                return {
                    ok: false,
                    code: REIMBURSEMENT_TRANSFER_RESULT.WALLET_DISABLED,
                    errorReason: "reimbursement_wallet_pin_mismatch"
                };

            }

        }

        if (this._snapshotRepository && gameId) {

            const snapshot = this._snapshotRepository.findByGameId(gameId);

            if (!snapshot) {

                return {
                    ok: false,
                    code: REIMBURSEMENT_TRANSFER_RESULT.DESTINATION_MISMATCH,
                    errorReason: "snapshot_missing_for_destination_check"
                };

            }

            if (
                snapshot.payload?.status
                    !== DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN
            ) {

                return {
                    ok: false,
                    code: REIMBURSEMENT_TRANSFER_RESULT.DESTINATION_MISMATCH,
                    errorReason: "snapshot_not_frozen"
                };

            }

            const snapDest = String(snapshot.payload?.deployWallet ?? "").trim();

            if (!reimbursementAddressesEqual(destination, snapDest)) {

                return {
                    ok: false,
                    code: REIMBURSEMENT_TRANSFER_RESULT.DESTINATION_MISMATCH,
                    errorReason: "destination_does_not_match_snapshot"
                };

            }

            const snapAmount = String(snapshot.payload?.deploymentCostTon ?? "").trim();
            const snapNano = tonStringToNanoton(snapAmount);

            if (snapNano == null || snapNano !== amountNano) {

                return {
                    ok: false,
                    code: REIMBURSEMENT_TRANSFER_RESULT.AMOUNT_INVALID,
                    errorReason: "amount_does_not_match_snapshot"
                };

            }

        }

        return {
            ok: true,
            destination,
            amountTon
        };

    }

}

/**
 * @param {string} code
 * @returns {string}
 */
function mapPolicyCode(code) {

    if (code === REIMBURSEMENT_POLICY_RESULT.AMOUNT_EXCEEDS_MAX) {

        return REIMBURSEMENT_TRANSFER_RESULT.AMOUNT_EXCEEDS_MAX;

    }

    if (code === REIMBURSEMENT_POLICY_RESULT.DAILY_LIMIT_REACHED) {

        return REIMBURSEMENT_TRANSFER_RESULT.DAILY_LIMIT_REACHED;

    }

    if (code === REIMBURSEMENT_POLICY_RESULT.AMOUNT_INVALID) {

        return REIMBURSEMENT_TRANSFER_RESULT.AMOUNT_INVALID;

    }

    if (code === REIMBURSEMENT_POLICY_RESULT.FEATURE_DISABLED) {

        return REIMBURSEMENT_TRANSFER_RESULT.FEATURE_DISABLED;

    }

    return REIMBURSEMENT_TRANSFER_RESULT.FAILED;

}
