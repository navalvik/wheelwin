import {
    buildOwnerPayout,
    buildRecipientPaysGasTransfer,
    buildSourceWalletTransfer,
    nanoToPersistedString,
    parseNanoString,
    assertNonNegativeNano,
    PAYOUT_GAS_MODE,
    PAYOUT_GAS_PLAN_CODES,
    PAYOUT_GAS_POLICY_VERSION,
    ROOM_WALLET_POLICY
} from "./RoomWalletFinancialPolicy.js";
import { normalizeRoomNumber } from "./RoomWalletRegistry.js";
import {
    canonicalizeTonWalletAddress,
    tonWalletAccountsEqual
} from "../../models/TonWalletAddress.js";
import {
    confirmPayoutOnChain,
    extractInbound,
    extractOutboundTransfers,
    inspectRoomWalletHistory
} from "./roomWalletTerminalRecoveryChain.js";

export const ROOM_WALLET_SETTLEMENT_SAFETY_CODES = Object.freeze({
    WALLET_REUSED: "WALLET_REUSED",
    DUPLICATE_PAYOUT: "DUPLICATE_PAYOUT",
    AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
    PAYOUT_PLAN_MISMATCH: PAYOUT_GAS_PLAN_CODES.PAYOUT_PLAN_MISMATCH
});

export const ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES = Object.freeze({
    CHAIN_INSPECT_UNKNOWN: "CHAIN_INSPECT_UNKNOWN",
    UNCERTAIN_BROADCAST: "UNCERTAIN_BROADCAST",
    INSUFFICIENT_ROOM_WALLET_BALANCE: "INSUFFICIENT_ROOM_WALLET_BALANCE",
    WINNER_PAYOUT_FAILED: "WINNER_PAYOUT_FAILED",
    OWNER_PAYOUT_FAILED_AFTER_WINNER: "OWNER_PAYOUT_FAILED_AFTER_WINNER",
    WINNER_PAYOUT_UNCONFIRMED: "WINNER_PAYOUT_UNCONFIRMED",
    OWNER_PAYOUT_UNCONFIRMED: "OWNER_PAYOUT_UNCONFIRMED",
    ADAPTER_THREW: "ADAPTER_THREW",
    PAYOUT_GAS_ESTIMATE_UNAVAILABLE: PAYOUT_GAS_PLAN_CODES.FEE_ESTIMATE_UNAVAILABLE,
    RECIPIENT_GAS_EXCEEDS_PAYOUT: PAYOUT_GAS_PLAN_CODES.RECIPIENT_GAS_EXCEEDS_PAYOUT,
    PAYOUT_PLAN_ENTRY_MISSING: PAYOUT_GAS_PLAN_CODES.PLAN_ENTRY_MISSING
});

export const ROOM_WALLET_PAYOUT_GAS_POLICY = Object.freeze({
    mode: PAYOUT_GAS_MODE.RECIPIENT_PAYS_GAS,
    feeSource: "estimateExternalMessageFee",
    feeComponents: Object.freeze([
        "in_fwd_fee",
        "storage_fee",
        "gas_fee",
        "fwd_fee"
    ])
});

/**
 * Reconciliation marker for a refund adopted from the destination player's
 * own inbound history (the Room Wallet outbound scan found no match).
 */
const PLAYER_WALLET_INBOUND_RECONCILIATION = "PLAYER_WALLET_INBOUND";

/**
 * Settlement adapter for the Room Wallet architecture.
 *
 * It consumes the already-calculated WheelWin settlement result. It does not
 * determine the winner, calculate the game pot, or change gameplay rules.
 *
 * PAYOUT GAS POLICY (explicit boundary):
 * - Winner payouts, Owner payouts and player refunds are RECIPIENT_PAYS_GAS
 *   transfers: the exact outbound message is fee-estimated through
 *   TonService.estimateExternalMessageFee BEFORE broadcast, a configurable
 *   safety margin is added, and the resulting recipient gas charge is
 *   deducted from the recipient's authoritative gross payout. The Room
 *   Wallet remains the technical sender; the game economics fund the
 *   source-side fee. Fee-estimation failure is fail-closed: there is no
 *   fallback to source-funded gas.
 * - Operational transfers (Residual sweep) stay SOURCE_PAYS_GAS and are not
 *   handled by this adapter.
 *
 * Determinism: the exact gross/gas-charge/net values are frozen into a
 * persisted payout/refund plan BEFORE the first broadcast. Recovery reuses
 * the persisted plan; it never re-estimates and can never produce a
 * different payout amount on retry.
 *
 * Authoritative ContractSettlementManager handoff fields:
 * winnerAmount, organizerAmount, roomNumber, winnerWallet, ownerWallet.
 * prizeAmount / prizeAmountNano remain aliases of the winner payout.
 */
export class RoomWalletSettlementAdapter {
    constructor({
        roomWalletAdapter,
        logger = null,
        inspectHistory = inspectRoomWalletHistory,
        confirmPayout = confirmPayoutOnChain,
        confirmTimeoutMs = 90_000,
        confirmPollMs = 2_000,
        recipientGasMarginBps = ROOM_WALLET_POLICY.recipientGasMarginBps,
        recipientGasMarginFloorNano = ROOM_WALLET_POLICY.recipientGasMarginFloorNano
    } = {}) {
        if (!roomWalletAdapter) {
            throw new Error("RoomWalletSettlementAdapter requires roomWalletAdapter");
        }

        if (typeof roomWalletAdapter.sendTransfer !== "function") {
            throw new TypeError("roomWalletAdapter.sendTransfer is required");
        }

        if (typeof roomWalletAdapter.getBalance !== "function") {
            throw new TypeError("roomWalletAdapter.getBalance is required");
        }

        if (typeof confirmPayout !== "function") {
            throw new TypeError("confirmPayout must be a function");
        }

        if (typeof recipientGasMarginBps !== "bigint" || recipientGasMarginBps < 0n) {
            throw new TypeError("recipientGasMarginBps must be a non-negative bigint");
        }

        assertNonNegativeNano(recipientGasMarginFloorNano, "recipientGasMarginFloorNano");

        this._roomWalletAdapter = roomWalletAdapter;
        this._logger = logger;
        this._inspectHistory = inspectHistory;
        this._confirmPayout = confirmPayout;
        this._confirmTimeoutMs = confirmTimeoutMs;
        this._confirmPollMs = confirmPollMs;
        this._recipientGasMarginBps = recipientGasMarginBps;
        this._recipientGasMarginFloorNano = recipientGasMarginFloorNano;
    }

    /**
     * PAYOUT GAS PLAN — compute (never broadcast).
     *
     * Estimates the source-side fee for the exact Winner and Owner outbound
     * messages, applies the configurable safety margin, deducts the recipient
     * gas charge from each authoritative gross payout and returns the frozen,
     * JSON-serializable plan. Every nano value is persisted as a decimal
     * string so the plan survives restart/retry byte-identically.
     *
     * Fail-closed: fee-estimation unavailability and gas-charge-equals-or-
     * exceeds-payout both return a retryable failure and never a
     * source-funded fallback.
     */
    async planSettlement(request = {}) {
        const roomNumber = resolveRoomNumber(request);
        const winnerWallet = requireWallet(request.winnerWallet, "winnerWallet");
        const ownerWallet = requireWallet(request.ownerWallet, "ownerWallet");
        const winnerAmountNano = resolveAuthoritativeWinnerAmountNano(request);
        const ownerGrossNano = resolveNano(
            request.organizerAmountNano,
            request.organizerAmount,
            "organizerAmount"
        );
        const ownerPlan = buildOwnerPayout({ ownerGrossNano });

        const winnerFee = await this._estimateTransferFee({
            roomNumber,
            destination: winnerWallet,
            amountNano: winnerAmountNano,
            queryId: request.winnerQueryId ?? null
        });

        if (!winnerFee.ok) {
            return Object.freeze({
                ok: false,
                retryable: true,
                code: winnerFee.code,
                detail: winnerFee.detail ?? null,
                role: "WINNER"
            });
        }

        const ownerFee = await this._estimateTransferFee({
            roomNumber,
            destination: ownerWallet,
            amountNano: ownerPlan.ownerPayoutNano,
            queryId: request.ownerQueryId ?? null
        });

        if (!ownerFee.ok) {
            return Object.freeze({
                ok: false,
                retryable: true,
                code: ownerFee.code,
                detail: ownerFee.detail ?? null,
                role: "OWNER"
            });
        }

        const winnerEntry = buildRecipientPaysGasTransfer({
            grossPayoutNano: winnerAmountNano,
            feeEstimateTotalNano: winnerFee.totalNano,
            marginBps: this._recipientGasMarginBps,
            marginFloorNano: this._recipientGasMarginFloorNano
        });

        if (!winnerEntry.ok) {
            return Object.freeze({
                ok: false,
                retryable: true,
                code: winnerEntry.code,
                detail: `WINNER grossNano=${winnerEntry.grossPayoutNano} gasChargeNano=${winnerEntry.recipientGasChargeNano}`,
                role: "WINNER"
            });
        }

        const ownerEntry = buildRecipientPaysGasTransfer({
            grossPayoutNano: ownerPlan.ownerPayoutNano,
            feeEstimateTotalNano: ownerFee.totalNano,
            marginBps: this._recipientGasMarginBps,
            marginFloorNano: this._recipientGasMarginFloorNano
        });

        if (!ownerEntry.ok) {
            return Object.freeze({
                ok: false,
                retryable: true,
                code: ownerEntry.code,
                detail: `OWNER grossNano=${ownerEntry.grossPayoutNano} gasChargeNano=${ownerEntry.recipientGasChargeNano}`,
                role: "OWNER"
            });
        }

        const payoutPlan = buildPersistedPayoutPlan({
            winnerEntry,
            ownerEntry,
            ownerPlan,
            winnerWallet,
            ownerWallet,
            winnerFee,
            ownerFee,
            marginBps: this._recipientGasMarginBps,
            marginFloorNano: this._recipientGasMarginFloorNano
        });

        this._logger?.info?.(
            `RoomWallet payout gas plan created | game=${request.gameId ?? "unknown"} `
                + `| room=${roomNumber} | gasPolicy=${PAYOUT_GAS_MODE.RECIPIENT_PAYS_GAS} `
                + `| winnerGrossNano=${winnerEntry.grossPayoutNano} `
                + `| winnerGasChargeNano=${winnerEntry.recipientGasChargeNano} `
                + `| winnerTransferNano=${winnerEntry.recipientTransferAmountNano} `
                + `| ownerGrossNano=${ownerGrossNano} `
                + `| ownerRetainedNano=${ownerPlan.retainedNano} `
                + `| ownerShareNano=${ownerPlan.ownerPayoutNano} `
                + `| ownerGasChargeNano=${ownerEntry.recipientGasChargeNano} `
                + `| ownerTransferNano=${ownerEntry.recipientTransferAmountNano} `
                + `| feeSource=${ROOM_WALLET_PAYOUT_GAS_POLICY.feeSource} `
                + `| winnerFeeEstimateNano=${winnerFee.totalNano} `
                + `| ownerFeeEstimateNano=${ownerFee.totalNano} `
                + `| marginBps=${this._recipientGasMarginBps} `
                + `| marginFloorNano=${this._recipientGasMarginFloorNano}`
        );

        return Object.freeze({ ok: true, payoutPlan });
    }

    async preflight(request = {}) {
        const roomNumber = resolveRoomNumber(request);
        const winnerAmountNano = resolveAuthoritativeWinnerAmountNano(request);
        const ownerGrossNano = resolveNano(
            request.organizerAmountNano,
            request.organizerAmount,
            "organizerAmount"
        );
        const ownerPlan = buildOwnerPayout({ ownerGrossNano });

        assertNonNegativeNano(winnerAmountNano, "winnerAmountNano");
        assertNonNegativeNano(ownerGrossNano, "ownerGrossNano");

        // PAYOUT GAS POLICY: the funding gate proves the Room Wallet can fund
        // the NET recipient transfers plus the estimated source-side fee
        // budget. It no longer requires the legacy blanket reserve that made
        // the wallet permanently pay game gas.
        const resolved = this._resolveFrozenPayoutPlan(request, {
            winnerAmountNano,
            ownerGrossNano,
            ownerPlan
        });

        if (resolved.mismatch) {
            return Object.freeze({
                ok: false,
                code: ROOM_WALLET_SETTLEMENT_SAFETY_CODES.PAYOUT_PLAN_MISMATCH,
                detail: resolved.detail,
                roomNumber,
                balanceNano: null,
                requiredNano: null,
                shortfallNano: null
            });
        }

        let plan = resolved.plan;

        if (!plan) {
            const computed = await this.planSettlement(request);

            if (!computed?.ok) {
                return Object.freeze({
                    ok: false,
                    code: computed?.code
                        ?? ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.PAYOUT_GAS_ESTIMATE_UNAVAILABLE,
                    planUnavailable: true,
                    detail: computed?.detail ?? null,
                    roomNumber,
                    balanceNano: null,
                    requiredNano: null,
                    shortfallNano: null
                });
            }

            plan = computed.payoutPlan;
        }

        return this._preflightWithPlan({
            roomNumber,
            plan,
            ownerPlan,
            winnerAmountNano,
            ownerGrossNano
        });
    }

    _preflightWithPlan({
        roomNumber,
        plan,
        ownerPlan,
        winnerAmountNano,
        ownerGrossNano
    }) {
        const winnerNetNano = toPlanNano(plan.winner.recipientTransferAmountNano, "winner.recipientTransferAmountNano");
        const ownerNetNano = toPlanNano(plan.owner.recipientTransferAmountNano, "owner.recipientTransferAmountNano");
        const winnerFeeBudgetNano = toPlanNano(plan.winner.feeEvidence.totalNano, "winner.feeEvidence.totalNano");
        const ownerFeeBudgetNano = toPlanNano(plan.owner.feeEvidence.totalNano, "owner.feeEvidence.totalNano");
        const winnerGasChargeNano = toPlanNano(plan.winner.recipientGasChargeNano, "winner.recipientGasChargeNano");
        const ownerGasChargeNano = toPlanNano(plan.owner.recipientGasChargeNano, "owner.recipientGasChargeNano");

        return this._roomWalletAdapter.getBalance(roomNumber).then((balanceNano) => {
            const totalPayoutNano = winnerNetNano + ownerNetNano;
            const totalGasReserveNano = winnerFeeBudgetNano + ownerFeeBudgetNano;
            const requiredNano = totalPayoutNano + totalGasReserveNano;

            return Object.freeze({
                ok: balanceNano >= requiredNano,
                roomNumber,
                balanceNano,
                gasPolicy: PAYOUT_GAS_MODE.RECIPIENT_PAYS_GAS,
                winner: Object.freeze({
                    grossPayoutNano: winnerAmountNano,
                    amountNano: winnerNetNano,
                    recipientGasChargeNano: winnerGasChargeNano,
                    feeBudgetNano: winnerFeeBudgetNano,
                    requiredNano: winnerNetNano + winnerFeeBudgetNano
                }),
                owner: Object.freeze({
                    grossNano: ownerGrossNano,
                    grossPayoutNano: ownerPlan.ownerPayoutNano,
                    amountNano: ownerNetNano,
                    retainedNano: ownerPlan.retainedNano,
                    recipientGasChargeNano: ownerGasChargeNano,
                    feeBudgetNano: ownerFeeBudgetNano,
                    requiredNano: ownerNetNano + ownerFeeBudgetNano
                }),
                totalPayoutNano,
                totalGasReserveNano,
                requiredNano,
                shortfallNano: balanceNano >= requiredNano
                    ? 0n
                    : requiredNano - balanceNano
            });
        });
    }

    /**
     * PARTIAL-SETTLEMENT RECOVERY FUNDING GATE.
     *
     * When the winner payout is already confirmed on-chain and only the Owner
     * payout is missing, the retry must NOT require the Room Wallet to fund
     * the already-completed winner payout again. Under RECIPIENT_PAYS_GAS the
     * remaining requirement is exactly the persisted NET Owner transfer plus
     * the estimated source-side fee budget for that single Owner transaction.
     *
     * Fail-closed fallback: when the adapter cannot expose canFundTransfer,
     * the stricter full settlement preflight is used instead.
     */
    async preflightRemainingOwner({
        request,
        roomNumber,
        ownerPlan,
        winnerAmountNano
    }) {
        assertNonNegativeNano(ownerPlan.ownerPayoutNano, "ownerPayoutNano");

        const ownerGrossNano = ownerPlan.ownerGrossNano;
        const resolved = this._resolveFrozenPayoutPlan(request, {
            winnerAmountNano,
            ownerGrossNano,
            ownerPlan
        });

        if (resolved.mismatch) {
            return Object.freeze({
                ok: false,
                code: ROOM_WALLET_SETTLEMENT_SAFETY_CODES.PAYOUT_PLAN_MISMATCH,
                detail: resolved.detail,
                remainingOnly: true,
                roomNumber,
                balanceNano: null,
                requiredNano: null,
                shortfallNano: null
            });
        }

        if (!resolved.plan) {
            return this.preflight(request);
        }

        const plan = resolved.plan;
        const ownerNetNano = toPlanNano(plan.owner.recipientTransferAmountNano, "owner.recipientTransferAmountNano");
        const ownerFeeBudgetNano = toPlanNano(plan.owner.feeEvidence.totalNano, "owner.feeEvidence.totalNano");

        if (typeof this._roomWalletAdapter.canFundTransfer !== "function") {
            return this.preflight({ ...request, payoutPlan: plan });
        }

        const check = await this._roomWalletAdapter.canFundTransfer({
            roomNumber,
            amountNano: ownerNetNano,
            sourceReserveNano: ownerFeeBudgetNano
        });
        const requiredNano = check?.requiredNano ?? (ownerNetNano + ownerFeeBudgetNano);

        return Object.freeze({
            ok: check?.ok === true,
            remainingOnly: true,
            roomNumber,
            gasPolicy: PAYOUT_GAS_MODE.RECIPIENT_PAYS_GAS,
            balanceNano: check?.balanceNano ?? null,
            winnerPayoutAlreadyOnChain: true,
            excludedWinnerAmountNano: winnerAmountNano,
            owner: Object.freeze({
                grossNano: ownerGrossNano,
                grossPayoutNano: ownerPlan.ownerPayoutNano,
                payoutNano: ownerNetNano,
                retainedNano: toPlanNano(plan.owner.ownerRetainedNano, "owner.ownerRetainedNano"),
                recipientGasChargeNano: toPlanNano(plan.owner.recipientGasChargeNano, "owner.recipientGasChargeNano"),
                feeBudgetNano: ownerFeeBudgetNano
            }),
            totalPayoutNano: ownerNetNano,
            totalGasReserveNano: ownerFeeBudgetNano,
            requiredNano,
            shortfallNano: check?.shortfallNano
                ?? (check?.balanceNano != null && check.balanceNano < requiredNano
                    ? requiredNano - check.balanceNano
                    : 0n)
        });
    }

    /**
     * Fee estimation for one exact outbound transfer via the Room Wallet
     * adapter. Fail-closed: returns ok:false when the adapter has no
     * estimation capability or the transport cannot estimate.
     */
    async _estimateTransferFee({
        roomNumber,
        destination,
        amountNano,
        queryId = null
    }) {
        if (typeof this._roomWalletAdapter.estimateOutboundTransferFee !== "function") {
            return Object.freeze({
                ok: false,
                code: ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.PAYOUT_GAS_ESTIMATE_UNAVAILABLE,
                detail: "room wallet adapter has no estimateOutboundTransferFee capability"
            });
        }

        try {
            const estimate = await this._roomWalletAdapter.estimateOutboundTransferFee({
                roomNumber,
                destination,
                amountNano,
                queryId
            });

            if (!estimate?.ok) {
                return Object.freeze({
                    ok: false,
                    code: ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.PAYOUT_GAS_ESTIMATE_UNAVAILABLE,
                    detail: estimate?.detail ?? estimate?.code ?? "fee estimate failed"
                });
            }

            return Object.freeze({
                ok: true,
                feeSource: estimate.feeSource ?? ROOM_WALLET_PAYOUT_GAS_POLICY.feeSource,
                totalNano: estimate.totalNano,
                inFwdFeeNano: estimate.inFwdFeeNano,
                storageFeeNano: estimate.storageFeeNano,
                gasFeeNano: estimate.gasFeeNano,
                fwdFeeNano: estimate.fwdFeeNano
            });
        } catch (error) {
            return Object.freeze({
                ok: false,
                code: ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.PAYOUT_GAS_ESTIMATE_UNAVAILABLE,
                detail: error?.message ?? String(error)
            });
        }
    }

    /**
     * Resolves the frozen payout plan carried on the request (persisted by
     * ContractSettlementManager BEFORE the first payout broadcast).
     *
     * A present plan is validated strictly against the authoritative gross
     * amounts, the immutable retention rule and its own fee evidence — a
     * tampered or mismatched plan fails closed (safety failure, non-
     * retryable). An absent plan is not an error: the caller computes one.
     */
    _resolveFrozenPayoutPlan(request, {
        winnerAmountNano,
        ownerGrossNano,
        ownerPlan
    }) {
        const raw = request?.payoutPlan ?? null;

        if (raw == null) {
            return Object.freeze({ mismatch: false, plan: null });
        }

        const validation = validatePersistedPayoutPlan(raw, {
            winnerAmountNano,
            ownerGrossNano,
            ownerPayoutNano: ownerPlan.ownerPayoutNano,
            ownerRetainedNano: ownerPlan.retainedNano,
            winnerWallet: request.winnerWallet ?? null,
            ownerWallet: request.ownerWallet ?? null
        });

        if (!validation.ok) {
            this._logger?.error?.(
                `RoomWallet payout plan mismatch | game=${request?.gameId ?? "unknown"} `
                    + `| detail=${validation.detail}`
            );

            return Object.freeze({
                mismatch: true,
                detail: validation.detail,
                plan: null
            });
        }

        return Object.freeze({ mismatch: false, plan: validation.plan });
    }

    /**
     * Non-secret recipient-pays-gas accounting log line (rule: observability
     * without secrets). Emitted after every recipient-pays-gas broadcast.
     */
    _logRecipientPaysGasTransfer({
        gameId = null,
        roomNumber,
        role,
        destination,
        planEntry,
        seqno = null,
        txHash = null
    }) {
        this._logger?.info?.(
            `RoomWallet recipient-pays-gas transfer | game=${gameId ?? "unknown"} `
                + `| room=${roomNumber} | role=${role} `
                + `| gasPolicy=${PAYOUT_GAS_MODE.RECIPIENT_PAYS_GAS} `
                + `| grossNano=${planEntry.grossPayoutNano} `
                + `| recipientGasChargeNano=${planEntry.recipientGasChargeNano} `
                + `| recipientTransferNano=${planEntry.recipientTransferAmountNano} `
                + `| feeSource=${ROOM_WALLET_PAYOUT_GAS_POLICY.feeSource} `
                + `| feeEstimateTotalNano=${planEntry.feeEvidence.totalNano} `
                + `| marginBps=${planEntry.marginBps} `
                + `| marginFloorNano=${planEntry.marginFloorNano} `
                + `| seqno=${seqno ?? "unknown"} `
                + `| txHash=${txHash ?? "unknown"} `
                + `| destination=${maskDestination(destination)}`
        );
    }

    /**
     * Positive on-chain confirmation of a freshly broadcast payout using the
     * existing WheelWin confirmation primitive (confirmPayoutOnChain). The
     * payout hash, destination and exact amount must all be observed in the
     * Room Wallet outbound history.
     *
     * When the transport cannot observe transactions at all, the legacy
     * no-observation behaviour is preserved (observed: false) and the caller
     * falls back to the existing broadcast-only result handling.
     */
    async _confirmTransferAfterBroadcast({
        roomNumber,
        history,
        txHash,
        destination,
        amountNano
    }) {
        if (typeof this._roomWalletAdapter.getTransactions !== "function") {
            return Object.freeze({
                observed: false,
                confirmed: false,
                reason: "OBSERVATION_UNAVAILABLE"
            });
        }

        const roomWalletAddress = history?.roomWalletAddress
            ?? (typeof this._roomWalletAdapter.getWalletAddress === "function"
                ? await this._roomWalletAdapter.getWalletAddress(roomNumber)
                : null);

        if (!roomWalletAddress) {
            return Object.freeze({
                observed: false,
                confirmed: false,
                reason: "ROOM_WALLET_ADDRESS_UNAVAILABLE"
            });
        }

        try {
            const confirmation = await this._confirmPayout({
                tonService: createInspectTransport(this._roomWalletAdapter, roomNumber),
                roomWalletAddress,
                expectedHash: txHash ?? null,
                destination,
                amountNano,
                timeoutMs: this._confirmTimeoutMs,
                pollIntervalMs: this._confirmPollMs
            });

            return Object.freeze({
                observed: true,
                confirmed: confirmation?.ok === true,
                ...confirmation
            });
        } catch (error) {
            this._logger?.warn?.(
                `RoomWallet settlement payout confirmation errored | `
                    + `room=${roomNumber} | ${error?.message ?? error}`
            );

            return Object.freeze({
                observed: true,
                confirmed: false,
                code: "PAYOUT_CONFIRMATION_ERROR",
                detail: error?.message ?? String(error)
            });
        }
    }

    /**
     * PAYOUT GAS PLAN for refunds — compute (never broadcast).
     *
     * Estimates the source-side fee for each refund's exact outbound message,
     * applies the configurable safety margin and freezes the NET refund per
     * player. The authoritative refundable amount (grossRefundNano) is never
     * changed: the player receives gross - recipient gas charge.
     */
    async planRefunds({ roomNumber, refunds = [] } = {}) {
        const normalizedRoomNumber = resolveRoomNumber({ roomNumber });
        const targets = Array.isArray(refunds) ? refunds : [];
        const entries = [];

        for (const target of targets) {
            const wallet = requireWallet(target?.wallet, "refund wallet");
            const amountNano = resolveNano(
                target?.amountNano,
                target?.amount,
                "refundAmount"
            );
            assertNonNegativeNano(amountNano, "refundAmountNano");

            if (amountNano <= 0n) {
                return Object.freeze({
                    ok: false,
                    retryable: false,
                    code: "INVALID_REFUND_AMOUNT",
                    detail: `playerId=${target?.playerId ?? "unknown"} amountNano=${amountNano}`
                });
            }

            let queryId;
            try {
                queryId = normalizeRefundQueryId(target?.queryId);
            } catch (error) {
                return Object.freeze({
                    ok: false,
                    retryable: false,
                    code: "INVALID_REFUND_QUERY_ID",
                    detail: error?.message ?? String(error)
                });
            }

            const fee = await this._estimateTransferFee({
                roomNumber: normalizedRoomNumber,
                destination: wallet,
                amountNano,
                queryId
            });

            if (!fee.ok) {
                return Object.freeze({
                    ok: false,
                    retryable: true,
                    code: fee.code,
                    detail: fee.detail ?? null
                });
            }

            const entry = buildRecipientPaysGasTransfer({
                grossPayoutNano: amountNano,
                feeEstimateTotalNano: fee.totalNano,
                marginBps: this._recipientGasMarginBps,
                marginFloorNano: this._recipientGasMarginFloorNano
            });

            if (!entry.ok) {
                return Object.freeze({
                    ok: false,
                    retryable: true,
                    code: entry.code,
                    detail: `playerId=${target?.playerId ?? "unknown"} grossNano=${entry.grossPayoutNano} gasChargeNano=${entry.recipientGasChargeNano}`
                });
            }

            entries.push(Object.freeze({
                playerId: target?.playerId ?? null,
                playerIndex: target?.playerIndex ?? null,
                wallet,
                queryId,
                grossRefundNano: nanoToPersistedString(amountNano),
                recipientGasChargeNano: nanoToPersistedString(entry.recipientGasChargeNano),
                recipientTransferAmountNano: nanoToPersistedString(entry.recipientTransferAmountNano),
                feeEvidence: Object.freeze({
                    inFwdFeeNano: nanoToPersistedString(fee.inFwdFeeNano),
                    storageFeeNano: nanoToPersistedString(fee.storageFeeNano),
                    gasFeeNano: nanoToPersistedString(fee.gasFeeNano),
                    fwdFeeNano: nanoToPersistedString(fee.fwdFeeNano),
                    totalNano: nanoToPersistedString(fee.totalNano)
                })
            }));
        }

        return Object.freeze({
            ok: true,
            refundPlan: Object.freeze({
                mode: PAYOUT_GAS_MODE.RECIPIENT_PAYS_GAS,
                gasPolicyVersion: PAYOUT_GAS_POLICY_VERSION,
                feeSource: ROOM_WALLET_PAYOUT_GAS_POLICY.feeSource,
                marginBps: this._recipientGasMarginBps.toString(10),
                marginFloorNano: nanoToPersistedString(this._recipientGasMarginFloorNano),
                entries: Object.freeze(entries)
            })
        });
    }

    /**
     * R18-S17 — Refund confirmed Room-Wallet player payments when a game
     * cannot reach Page5 after a partial payment. Refunds are sent from the
     * same authoritative Room Wallet that received the player stakes.
     *
     * The operation is idempotent across process restarts: before broadcasting
     * a refund we inspect recent Room-Wallet history for an already completed
     * transfer to the same player.
     *
     * PAYOUT GAS POLICY: refunds are RECIPIENT_PAYS_GAS transfers. The exact
     * gross/gas/net values come from a frozen refund plan (persisted by
     * PaymentSessionManager BEFORE the first refund broadcast). The player
     * receives the authoritative refundable amount minus the recipient gas
     * charge. Without a provided plan the batch plan is computed here (still
     * fail-closed) and echoed in the result for persistence.
     */
    async refundPayments({
        roomNumber,
        paymentSessionId = null,
        refunds = [],
        refundPlan = null,
        cutoffUtime = null,
        confirmationTimeoutMs = 60_000
    } = {}) {
        const normalizedRoomNumber = resolveRoomNumber({ roomNumber });
        const targets = Array.isArray(refunds) ? refunds : [];
        const results = [];

        let plan = null;

        if (refundPlan != null) {
            const validation = validateRefundPlanShape(refundPlan);

            if (!validation.ok) {
                this._logger?.error?.(
                    `RoomWallet refund plan mismatch | room=${normalizedRoomNumber} `
                        + `| detail=${validation.detail}`
                );

                return Object.freeze({
                    ok: false,
                    retryable: false,
                    code: ROOM_WALLET_SETTLEMENT_SAFETY_CODES.PAYOUT_PLAN_MISMATCH,
                    detail: validation.detail,
                    roomNumber: normalizedRoomNumber,
                    results: Object.freeze([])
                });
            }

            plan = validation.plan;
        } else {
            const computed = await this.planRefunds({
                roomNumber: normalizedRoomNumber,
                refunds: targets
            });

            if (!computed?.ok) {
                // FAIL CLOSED: no fee estimate, no broadcast, and never a
                // source-funded gas fallback.
                return Object.freeze({
                    ok: false,
                    retryable: computed?.retryable !== false,
                    code: computed?.code
                        ?? ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.PAYOUT_GAS_ESTIMATE_UNAVAILABLE,
                    detail: computed?.detail ?? null,
                    roomNumber: normalizedRoomNumber,
                    results: Object.freeze([])
                });
            }

            plan = computed.refundPlan;
        }

        for (const target of targets) {
            const wallet = requireWallet(target?.wallet, "refund wallet");
            const amountNano = resolveNano(
                target?.amountNano,
                target?.amount,
                "refundAmount"
            );

            assertNonNegativeNano(amountNano, "refundAmountNano");

            if (amountNano <= 0n) {
                results.push(Object.freeze({
                    ok: false,
                    playerId: target?.playerId ?? null,
                    playerIndex: target?.playerIndex ?? null,
                    wallet,
                    amountNano,
                    code: "INVALID_REFUND_AMOUNT"
                }));
                continue;
            }

            const entry = findRefundPlanEntry(plan, { target, wallet, amountNano });

            if (!entry) {
                results.push(Object.freeze({
                    ok: false,
                    retryable: true,
                    code: ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.PAYOUT_PLAN_ENTRY_MISSING,
                    playerId: target?.playerId ?? null,
                    playerIndex: target?.playerIndex ?? null,
                    wallet,
                    amountNano
                }));
                continue;
            }

            const netNano = toPlanNano(entry.recipientTransferAmountNano, "entry.recipientTransferAmountNano");
            const gasChargeNano = toPlanNano(entry.recipientGasChargeNano, "entry.recipientGasChargeNano");
            const feeBudgetNano = toPlanNano(entry.feeEvidence.totalNano, "entry.feeEvidence.totalNano");

            if (netNano <= 0n) {
                results.push(Object.freeze({
                    ok: false,
                    retryable: true,
                    code: ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.RECIPIENT_GAS_EXCEEDS_PAYOUT,
                    playerId: target?.playerId ?? null,
                    playerIndex: target?.playerIndex ?? null,
                    wallet,
                    amountNano,
                    recipientGasChargeNano: gasChargeNano,
                    recipientTransferAmountNano: netNano
                }));
                continue;
            }

            const queryId = entry.queryId ?? target?.queryId ?? null;
            if (
                target?.queryId != null
                && String(target.queryId) !== String(entry.queryId ?? "")
            ) {
                results.push(Object.freeze({
                    ok: false,
                    retryable: false,
                    code: "REFUND_QUERY_ID_MISMATCH",
                    playerId: target?.playerId ?? null,
                    playerIndex: target?.playerIndex ?? null,
                    wallet,
                    amountNano: netNano
                }));
                continue;
            }

            const existing = await this._findExistingRefund({
                roomNumber: normalizedRoomNumber,
                wallet,
                amountNano: netNano,
                legacyAmountNano: amountNano === netNano ? null : amountNano,
                queryId,
                cutoffUtime
            });

            if (existing) {
                const reconciledFromPlayerWallet =
                    existing.reconciliation === PLAYER_WALLET_INBOUND_RECONCILIATION;

                if (reconciledFromPlayerWallet) {
                    this._logger?.info?.(
                        `RoomWallet refund reconciled from player wallet history | `
                            + `room=${normalizedRoomNumber} | playerWallet=${wallet} `
                            + `| roomWallet=${existing.source ?? "unknown"} `
                            + `| amountNano=${netNano} `
                            + `| txHash=${existing.hash ?? "unknown"} `
                            + `| reconciliation=${PLAYER_WALLET_INBOUND_RECONCILIATION}`
                    );
                }

                results.push(Object.freeze({
                    ok: true,
                    code: reconciledFromPlayerWallet
                        ? "REFUND_RECONCILED_FROM_PLAYER_WALLET"
                        : "REFUND_ADOPTED",
                    confirmed: true,
                    ...(reconciledFromPlayerWallet
                        ? { reconciliation: PLAYER_WALLET_INBOUND_RECONCILIATION }
                        : {}),
                    playerId: target?.playerId ?? null,
                    playerIndex: target?.playerIndex ?? null,
                    wallet,
                    amountNano: netNano,
                    grossRefundNano: amountNano,
                    recipientGasChargeNano: gasChargeNano,
                    txHash: existing.hash ?? null
                }));
                continue;
            }

            let sent;
            try {
                sent = await this._roomWalletAdapter.sendTransfer({
                    roomNumber: normalizedRoomNumber,
                    destination: wallet,
                    // RECIPIENT_PAYS_GAS: the broadcast value is the persisted
                    // NET refund; the plan's fee estimate is the source-side
                    // funding requirement (not the legacy blanket reserve).
                    amountNano: netNano,
                    queryId: target?.queryId ?? null,
                    sourceReserveNano: feeBudgetNano
                });
            } catch (error) {
                results.push(Object.freeze({
                    ok: false,
                    retryable: true,
                    code: "REFUND_ADAPTER_ERROR",
                    playerId: target?.playerId ?? null,
                    playerIndex: target?.playerIndex ?? null,
                    wallet,
                    amountNano: netNano,
                    grossRefundNano: amountNano,
                    recipientGasChargeNano: gasChargeNano,
                    error: error?.message ?? String(error)
                }));
                continue;
            }

            this._logRecipientPaysGasTransfer({
                gameId: null,
                roomNumber: normalizedRoomNumber,
                role: "REFUND",
                destination: wallet,
                planEntry: {
                    grossPayoutNano: amountNano,
                    recipientGasChargeNano: gasChargeNano,
                    recipientTransferAmountNano: netNano,
                    feeEvidence: entry.feeEvidence,
                    marginBps: plan.marginBps,
                    marginFloorNano: plan.marginFloorNano
                },
                seqno: sent?.seqno ?? null,
                txHash: sent?.txHash ?? null
            });

            if (!sent?.ok) {
                results.push(Object.freeze({
                    ok: false,
                    retryable: true,
                    code: sent?.code ?? "REFUND_BROADCAST_FAILED",
                    playerId: target?.playerId ?? null,
                    playerIndex: target?.playerIndex ?? null,
                    wallet,
                    amountNano: netNano,
                    grossRefundNano: amountNano,
                    recipientGasChargeNano: gasChargeNano,
                    txHash: sent?.txHash ?? null
                }));
                continue;
            }

            if (!sent.txHash) {
                results.push(Object.freeze({
                    ok: false,
                    retryable: true,
                    code: "REFUND_UNCERTAIN_BROADCAST",
                    playerId: target?.playerId ?? null,
                    playerIndex: target?.playerIndex ?? null,
                    wallet,
                    amountNano: netNano,
                    grossRefundNano: amountNano,
                    recipientGasChargeNano: gasChargeNano,
                    txHash: null
                }));
                continue;
            }

            const confirmed = await confirmPayoutOnChain({
                tonService: createInspectTransport(this._roomWalletAdapter, normalizedRoomNumber),
                roomWalletAddress: await this._roomWalletAdapter.getWalletAddress(normalizedRoomNumber),
                expectedHash: sent.txHash ?? null,
                destination: wallet,
                amountNano: netNano,
                queryId,
                timeoutMs: confirmationTimeoutMs
            });

            if (!confirmed?.ok) {
                results.push(Object.freeze({
                    ok: false,
                    retryable: true,
                    code: "REFUND_NOT_CONFIRMED",
                    playerId: target?.playerId ?? null,
                    playerIndex: target?.playerIndex ?? null,
                    wallet,
                    amountNano: netNano,
                    grossRefundNano: amountNano,
                    recipientGasChargeNano: gasChargeNano,
                    txHash: sent.txHash ?? null
                }));
                continue;
            }

            results.push(Object.freeze({
                ok: true,
                code: "REFUND_CONFIRMED",
                confirmed: true,
                playerId: target?.playerId ?? null,
                playerIndex: target?.playerIndex ?? null,
                wallet,
                amountNano: netNano,
                grossRefundNano: amountNano,
                recipientGasChargeNano: gasChargeNano,
                txHash: confirmed.hash ?? sent.txHash ?? null
            }));
        }

        return Object.freeze({
            ok: results.every((result) => result.ok === true),
            roomNumber: normalizedRoomNumber,
            refundPlan: plan,
            results: Object.freeze(results)
        });
    }

    async _findExistingRefund({
        roomNumber,
        wallet,
        amountNano,
        legacyAmountNano = null,
        queryId = null,
        cutoffUtime
    }) {
        if (typeof this._roomWalletAdapter.getTransactions !== "function") {
            return null;
        }

        const cutoff = resolveCutoffUtime({ cutoffUtime });
        const transactions = await this._roomWalletAdapter.getTransactions(
            roomNumber,
            { limit: 40, archival: true }
        );

        for (const tx of transactions ?? []) {
            const transfers = extractOutboundTransfers(tx);
            for (const transfer of transfers) {
                if (
                    transfer.success
                    && transfer.bounced !== true
                    && (transfer.amountNano === amountNano
                        || (legacyAmountNano != null && transfer.amountNano === legacyAmountNano))
                    && tonWalletAccountsEqual(transfer.destination, wallet)
                    && (
                        queryId == null
                        || (
                            transfer.hash != null
                            && String(transfer.queryId ?? "") === String(queryId)
                        )
                    )
                    && (cutoff == null || transfer.utime > cutoff)
                ) {
                    return transfer;
                }
            }
        }

        // The Room Wallet history may have failed to observe a refund that in
        // fact reached the player. Fall back to the destination player's own
        // inbound history — read-only reconciliation; never a second broadcast.
        if (typeof this._roomWalletAdapter.getAddressTransactions !== "function") {
            return null;
        }

        const roomWalletAddress = typeof this._roomWalletAdapter.getWalletAddress === "function"
            ? await this._roomWalletAdapter.getWalletAddress(roomNumber)
            : null;

        if (!roomWalletAddress) {
            return null;
        }

        const playerTransactions = await this._roomWalletAdapter.getAddressTransactions(
            wallet,
            { limit: 40, archival: true }
        );

        for (const tx of playerTransactions ?? []) {
            const inbound = extractInbound(tx);
            if (
                inbound
                && inbound.success
                && inbound.bounced !== true
                && (inbound.amountNano === amountNano
                    || (legacyAmountNano != null && inbound.amountNano === legacyAmountNano))
                && tonWalletAccountsEqual(inbound.source, roomWalletAddress)
                && (
                    queryId == null
                    || (
                        inbound.hash != null
                        && String(inbound.queryId ?? "") === String(queryId)
                    )
                )
                && (cutoff == null || inbound.utime > cutoff)
            ) {
                return Object.freeze({
                    ...inbound,
                    reconciliation: PLAYER_WALLET_INBOUND_RECONCILIATION
                });
            }
        }

        return null;
    }

    async inspectSettlement(request = {}, { payoutPlan = null } = {}) {
        const roomNumber = resolveRoomNumber(request);
        const winnerWallet = requireWallet(request.winnerWallet, "winnerWallet");
        const ownerWallet = requireWallet(request.ownerWallet, "ownerWallet");
        const winnerAmountNano = resolveAuthoritativeWinnerAmountNano(request);
        const ownerGrossNano = resolveNano(
            request.organizerAmountNano,
            request.organizerAmount,
            "organizerAmount"
        );
        const ownerPlan = buildOwnerPayout({ ownerGrossNano });

        if (typeof this._roomWalletAdapter.getTransactions !== "function"
            && typeof this._inspectHistory !== "function") {
            return Object.freeze({ unavailable: true, roomNumber });
        }

        const roomWalletAddress = typeof this._roomWalletAdapter.getWalletAddress === "function"
            ? await this._roomWalletAdapter.getWalletAddress(roomNumber)
            : request.roomWalletAddress ?? null;

        if (!roomWalletAddress) {
            return Object.freeze({ unavailable: true, roomNumber });
        }

        // PAYOUT GAS POLICY: with a frozen plan the on-chain match amounts are
        // the persisted NET recipient transfer values. The authoritative gross
        // values stay as legacy alternation amounts so pre-sprint partial
        // settlements (paid at gross) are still adopted instead of duplicated.
        let winnerMatchNano = winnerAmountNano;
        let ownerMatchNano = ownerPlan.ownerPayoutNano;
        let winnerLegacyMatchNano = null;
        let ownerLegacyMatchNano = null;

        if (payoutPlan) {
            winnerMatchNano = toPlanNano(payoutPlan.winner.recipientTransferAmountNano, "payoutPlan.winner.recipientTransferAmountNano");
            ownerMatchNano = toPlanNano(payoutPlan.owner.recipientTransferAmountNano, "payoutPlan.owner.recipientTransferAmountNano");
            winnerLegacyMatchNano = winnerMatchNano === winnerAmountNano
                ? null
                : winnerAmountNano;
            ownerLegacyMatchNano = ownerMatchNano === ownerPlan.ownerPayoutNano
                ? null
                : ownerPlan.ownerPayoutNano;
        }

        try {
            const history = await this._inspectHistory({
                tonService: createInspectTransport(this._roomWalletAdapter, roomNumber),
                roomWalletAddress,
                cutoffLt: request.cutoffLt ?? null,
                cutoffUtime: resolveCutoffUtime(request),
                winnerWallet,
                ownerWallet,
                winnerAmountNano: winnerMatchNano,
                ownerAmountNano: ownerMatchNano,
                winnerLegacyAmountNano: winnerLegacyMatchNano,
                ownerLegacyAmountNano: ownerLegacyMatchNano
            });
            return Object.freeze({
                unavailable: false,
                unknown: false,
                roomNumber,
                roomWalletAddress,
                winnerAmountNano,
                ownerPayoutNano: ownerPlan.ownerPayoutNano,
                ownerRetainedNano: ownerPlan.retainedNano,
                winnerMatchNano,
                ownerMatchNano,
                ...history
            });
        } catch (error) {
            this._logger?.warn?.(
                `RoomWallet settlement inspect unknown | game=${request.gameId ?? "unknown"} | `
                    + `${error?.message ?? error}`
            );
            return Object.freeze({
                unavailable: false,
                unknown: true,
                retryable: true,
                code: ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.CHAIN_INSPECT_UNKNOWN,
                roomNumber,
                detail: error?.message ?? String(error)
            });
        }
    }

    async settleContract(request = {}) {
        const roomNumber = resolveRoomNumber(request);
        const winnerWallet = requireWallet(request.winnerWallet, "winnerWallet");
        const ownerWallet = requireWallet(request.ownerWallet, "ownerWallet");
        const winnerAmountNano = resolveAuthoritativeWinnerAmountNano(request);
        const ownerGrossNano = resolveNano(
            request.organizerAmountNano,
            request.organizerAmount,
            "organizerAmount"
        );
        const ownerPlan = buildOwnerPayout({ ownerGrossNano });

        // PAYOUT GAS POLICY: resolve the frozen plan persisted by the
        // settlement lifecycle BEFORE the first payout broadcast. A present
        // but inconsistent plan is a safety failure; an absent plan is
        // computed lazily below (also fail-closed) when a payout is needed.
        const frozenPlan = this._resolveFrozenPayoutPlan(request, {
            winnerAmountNano,
            ownerGrossNano,
            ownerPlan
        });

        if (frozenPlan.mismatch) {
            return Object.freeze({
                ok: false,
                retryable: false,
                chainInspected: false,
                code: ROOM_WALLET_SETTLEMENT_SAFETY_CODES.PAYOUT_PLAN_MISMATCH,
                detail: frozenPlan.detail,
                roomNumber,
                winner: null,
                owner: null
            });
        }

        const frozenPayoutPlan = frozenPlan.plan;

        const history = await this.inspectSettlement(request, { payoutPlan: frozenPayoutPlan });
        if (history?.unknown === true) {
            return Object.freeze({
                ok: false,
                retryable: true,
                chainInspected: true,
                code: ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.CHAIN_INSPECT_UNKNOWN,
                roomNumber,
                payoutPlan: frozenPayoutPlan,
                winner: null,
                owner: null
            });
        }

        if (history && history.unavailable !== true) {
            if (history.reused) {
                return Object.freeze({
                    ok: false,
                    retryable: false,
                    chainInspected: true,
                    code: ROOM_WALLET_SETTLEMENT_SAFETY_CODES.WALLET_REUSED,
                    roomNumber,
                    laterCount: history.laterCount,
                    payoutPlan: frozenPayoutPlan,
                    winner: null,
                    owner: null
                });
            }

            if (history.winnerPayoutCount > 1 || history.ownerPayoutCount > 1) {
                return Object.freeze({
                    ok: false,
                    retryable: false,
                    chainInspected: true,
                    code: ROOM_WALLET_SETTLEMENT_SAFETY_CODES.DUPLICATE_PAYOUT,
                    roomNumber,
                    winnerPayoutCount: history.winnerPayoutCount,
                    ownerPayoutCount: history.ownerPayoutCount,
                    payoutPlan: frozenPayoutPlan,
                    winner: history.winnerPayout,
                    owner: history.ownerPayout
                });
            }

            if (history.winnerPayout && history.ownerPayout) {
                return Object.freeze({
                    ok: true,
                    code: "SETTLEMENT_ADOPTED",
                    chainInspected: true,
                    winnerConfirmed: true,
                    ownerConfirmed: true,
                    roomNumber,
                    gameId: request.gameId ?? null,
                    winner: adoptedTransfer(history.winnerPayout),
                    owner: adoptedTransfer(history.ownerPayout),
                    winnerAmountNano,
                    ownerGrossNano,
                    ownerPayoutNano: ownerPlan.ownerPayoutNano,
                    ownerRetainedNano: ownerPlan.retainedNano,
                    payoutPlan: frozenPayoutPlan,
                    winnerTransfer: null,
                    ownerTransfer: null
                });
            }
        }

        const needWinner = !(history && history.unavailable !== true && history.winnerPayout);
        const needOwner = !(history && history.unavailable !== true && history.ownerPayout);

        // PAYOUT GAS POLICY state for this pass. winner/ownerTransfer carry
        // the recipient-pays-gas accounting: recipientCreditNano is the NET
        // recipient transfer, sourceDebitNano is net + estimated source fee.
        let payoutPlan = frozenPayoutPlan;
        let winnerNetNano = winnerAmountNano;
        let ownerNetNano = ownerPlan.ownerPayoutNano;
        let winnerFeeBudgetNano = 0n;
        let ownerFeeBudgetNano = 0n;
        let winnerTransfer = null;
        let ownerTransfer = null;

        if (needWinner || needOwner) {
            if (!payoutPlan) {
                const computed = await this.planSettlement(request);

                if (!computed?.ok) {
                    // FAIL CLOSED: no fee estimate, no broadcast, and never a
                    // source-funded gas fallback.
                    return Object.freeze({
                        ok: false,
                        retryable: true,
                        chainInspected: history?.unavailable !== true,
                        code: computed?.code
                            ?? ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.PAYOUT_GAS_ESTIMATE_UNAVAILABLE,
                        detail: computed?.detail ?? null,
                        roomNumber,
                        payoutPlan: null,
                        winner: history?.winnerPayout ? adoptedTransfer(history.winnerPayout) : null,
                        owner: history?.ownerPayout ? adoptedTransfer(history.ownerPayout) : null
                    });
                }

                payoutPlan = computed.payoutPlan;
            }

            winnerNetNano = toPlanNano(payoutPlan.winner.recipientTransferAmountNano, "winner.recipientTransferAmountNano");
            ownerNetNano = toPlanNano(payoutPlan.owner.recipientTransferAmountNano, "owner.recipientTransferAmountNano");
            winnerFeeBudgetNano = toPlanNano(payoutPlan.winner.feeEvidence.totalNano, "winner.feeEvidence.totalNano");
            ownerFeeBudgetNano = toPlanNano(payoutPlan.owner.feeEvidence.totalNano, "owner.feeEvidence.totalNano");

            winnerTransfer = buildSourceWalletTransfer({
                amountNano: winnerNetNano,
                gasNano: winnerFeeBudgetNano
            });
            ownerTransfer = buildSourceWalletTransfer({
                amountNano: ownerNetNano,
                gasNano: ownerFeeBudgetNano
            });

            // PARTIAL-SETTLEMENT RECOVERY: when the winner payout is already
            // confirmed on-chain and only the Owner payout is missing, the
            // retry must not require the Room Wallet to fund the completed
            // winner payout again. Under RECIPIENT_PAYS_GAS the remaining
            // requirement is the NET Owner transfer plus its fee budget.
            const planRequest = { ...request, payoutPlan };
            const preflight = needWinner
                ? await this.preflight(planRequest)
                : await this.preflightRemainingOwner({
                    request: planRequest,
                    roomNumber,
                    ownerPlan,
                    winnerAmountNano
                });

            if (!preflight.ok) {
                return Object.freeze({
                    ok: false,
                    retryable: true,
                    chainInspected: history?.unavailable !== true,
                    code: ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.INSUFFICIENT_ROOM_WALLET_BALANCE,
                    roomNumber,
                    preflight,
                    payoutPlan,
                    winner: history?.winnerPayout ? adoptedTransfer(history.winnerPayout) : null,
                    owner: history?.ownerPayout ? adoptedTransfer(history.ownerPayout) : null
                });
            }
        }

        let winnerResult = history?.winnerPayout
            ? adoptedTransfer(history.winnerPayout)
            : null;
        let ownerResult = history?.ownerPayout
            ? adoptedTransfer(history.ownerPayout)
            : null;
        let winnerConfirmationEvidence = null;
        let ownerConfirmationEvidence = null;

        if (needWinner) {
            winnerResult = await this._roomWalletAdapter.sendTransfer({
                roomNumber,
                destination: winnerWallet,
                // RECIPIENT_PAYS_GAS: the broadcast value is the persisted NET
                // recipient transfer. The plan's fee estimate acts as the
                // source-side funding requirement (net + fee budget), not the
                // legacy blanket reserve.
                amountNano: winnerNetNano,
                queryId: request.winnerQueryId ?? null,
                sourceReserveNano: winnerFeeBudgetNano
            });

            this._logRecipientPaysGasTransfer({
                gameId: request.gameId ?? null,
                roomNumber,
                role: "WINNER",
                destination: winnerWallet,
                planEntry: payoutPlan.winner,
                seqno: winnerResult?.seqno ?? null,
                txHash: winnerResult?.txHash ?? null
            });

            if (!winnerResult?.ok) {
                return Object.freeze({
                    ok: false,
                    retryable: true,
                    chainInspected: history?.unavailable !== true,
                    code: winnerResult?.code ?? ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.WINNER_PAYOUT_FAILED,
                    roomNumber,
                    winner: winnerResult,
                    owner: ownerResult,
                    payoutPlan,
                    winnerTransfer,
                    ownerTransfer
                });
            }

            // SEQUENTIAL SETTLEMENT SAFETY: the Owner payout must never be
            // broadcast as an independent transaction before the Winner
            // payout is positively confirmed on-chain. Broadcasting both from
            // the same Room Wallet without confirmation reused the same seqno
            // in production (game_8b040e1c-1007-463f-bde7-8056c6dd3124) and
            // the Owner transfer was silently dropped by the wallet.
            const winnerConfirmation = await this._confirmTransferAfterBroadcast({
                roomNumber,
                history,
                txHash: winnerResult.txHash ?? null,
                destination: winnerWallet,
                amountNano: winnerNetNano
            });

            if (winnerConfirmation.observed && !winnerConfirmation.confirmed) {
                return Object.freeze({
                    ok: false,
                    retryable: true,
                    partial: true,
                    chainInspected: true,
                    code: ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.WINNER_PAYOUT_UNCONFIRMED,
                    roomNumber,
                    winner: winnerResult,
                    owner: ownerResult,
                    payoutPlan,
                    winnerTransfer,
                    ownerTransfer,
                    winnerConfirmation
                });
            }

            winnerConfirmationEvidence = winnerConfirmation;
        }

        if (needOwner) {
            ownerResult = await this._roomWalletAdapter.sendTransfer({
                roomNumber,
                destination: ownerWallet,
                // RECIPIENT_PAYS_GAS: persisted NET Owner transfer (gross
                // share - 0.01 GRAM retention - recipient gas charge).
                amountNano: ownerNetNano,
                queryId: request.ownerQueryId ?? null,
                sourceReserveNano: ownerFeeBudgetNano
            });

            this._logRecipientPaysGasTransfer({
                gameId: request.gameId ?? null,
                roomNumber,
                role: "OWNER",
                destination: ownerWallet,
                planEntry: payoutPlan.owner,
                seqno: ownerResult?.seqno ?? null,
                txHash: ownerResult?.txHash ?? null
            });

            if (!ownerResult?.ok) {
                this._logger?.error?.(
                    `RoomWallet settlement partially completed | game=${request.gameId ?? "unknown"} `
                    + `room=${roomNumber} | winnerTx=${winnerResult?.txHash ?? "unknown"}`
                );

                return Object.freeze({
                    ok: false,
                    retryable: true,
                    partial: true,
                    chainInspected: history?.unavailable !== true,
                    code: ownerResult?.code
                        ?? ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.OWNER_PAYOUT_FAILED_AFTER_WINNER,
                    roomNumber,
                    winner: winnerResult,
                    owner: ownerResult,
                    payoutPlan,
                    winnerTransfer,
                    ownerTransfer,
                    ownerRetainedNano: ownerPlan.retainedNano
                });
            }

            // SEQUENTIAL SETTLEMENT SAFETY: settlement may only be treated as
            // complete when the Owner payout is positively confirmed on-chain.
            // If confirmation times out the state stays retryable; the next
            // attempt re-inspects chain history and adopts the Owner payout
            // instead of broadcasting a duplicate.
            const ownerConfirmation = await this._confirmTransferAfterBroadcast({
                roomNumber,
                history,
                txHash: ownerResult.txHash ?? null,
                destination: ownerWallet,
                amountNano: ownerNetNano
            });

            if (ownerConfirmation.observed && !ownerConfirmation.confirmed) {
                return Object.freeze({
                    ok: false,
                    retryable: true,
                    partial: true,
                    chainInspected: true,
                    code: ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.OWNER_PAYOUT_UNCONFIRMED,
                    roomNumber,
                    winner: winnerResult,
                    owner: ownerResult,
                    payoutPlan,
                    winnerTransfer,
                    ownerTransfer,
                    ownerRetainedNano: ownerPlan.retainedNano,
                    ownerConfirmation
                });
            }

            ownerConfirmationEvidence = ownerConfirmation;
        }

        const afterSend = history?.unavailable === true
            ? null
            : await this.inspectSettlement(request, { payoutPlan });

        if (afterSend?.unknown === true) {
            return Object.freeze({
                ok: false,
                retryable: true,
                chainInspected: true,
                code: ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.UNCERTAIN_BROADCAST,
                roomNumber,
                payoutPlan,
                winner: winnerResult,
                owner: ownerResult,
                winnerTransfer,
                ownerTransfer
            });
        }

        if (afterSend && afterSend.unavailable !== true) {
            if (afterSend.reused) {
                return Object.freeze({
                    ok: false,
                    retryable: false,
                    chainInspected: true,
                    code: ROOM_WALLET_SETTLEMENT_SAFETY_CODES.WALLET_REUSED,
                    roomNumber,
                    payoutPlan,
                    winner: winnerResult,
                    owner: ownerResult
                });
            }
            if (afterSend.winnerPayoutCount > 1 || afterSend.ownerPayoutCount > 1) {
                return Object.freeze({
                    ok: false,
                    retryable: false,
                    chainInspected: true,
                    code: ROOM_WALLET_SETTLEMENT_SAFETY_CODES.DUPLICATE_PAYOUT,
                    roomNumber,
                    winnerPayoutCount: afterSend.winnerPayoutCount,
                    ownerPayoutCount: afterSend.ownerPayoutCount,
                    payoutPlan,
                    winner: afterSend.winnerPayout
                        ? adoptedTransfer(afterSend.winnerPayout)
                        : winnerResult,
                    owner: afterSend.ownerPayout
                        ? adoptedTransfer(afterSend.ownerPayout)
                        : ownerResult
                });
            }
            if (afterSend.winnerPayout && afterSend.ownerPayout) {
                return Object.freeze({
                    ok: true,
                    code: "SETTLEMENT_BROADCAST",
                    chainInspected: true,
                    winnerConfirmed: true,
                    ownerConfirmed: true,
                    roomNumber,
                    gameId: request.gameId ?? null,
                    winner: adoptedTransfer(afterSend.winnerPayout),
                    owner: adoptedTransfer(afterSend.ownerPayout),
                    winnerAmountNano,
                    ownerGrossNano,
                    ownerPayoutNano: ownerPlan.ownerPayoutNano,
                    ownerRetainedNano: ownerPlan.retainedNano,
                    winnerNetTransferNano: winnerNetNano,
                    ownerNetTransferNano: ownerNetNano,
                    payoutPlan,
                    winnerTransfer,
                    ownerTransfer,
                    winnerConfirmation: winnerConfirmationEvidence,
                    ownerConfirmation: ownerConfirmationEvidence
                });
            }
            return Object.freeze({
                ok: false,
                retryable: true,
                chainInspected: true,
                code: ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.UNCERTAIN_BROADCAST,
                roomNumber,
                payoutPlan,
                winner: winnerResult,
                owner: ownerResult,
                winnerTransfer,
                ownerTransfer
            });
        }

        return Object.freeze({
            ok: true,
            code: "SETTLEMENT_BROADCAST",
            chainInspected: false,
            winnerConfirmed: Boolean(winnerResult?.ok),
            ownerConfirmed: Boolean(ownerResult?.ok),
            roomNumber,
            gameId: request.gameId ?? null,
            winner: winnerResult,
            owner: ownerResult,
            winnerAmountNano,
            ownerGrossNano,
            ownerPayoutNano: ownerPlan.ownerPayoutNano,
            ownerRetainedNano: ownerPlan.retainedNano,
            winnerNetTransferNano: winnerNetNano,
            ownerNetTransferNano: ownerNetNano,
            payoutPlan,
            winnerTransfer,
            ownerTransfer,
            winnerConfirmation: winnerConfirmationEvidence,
            ownerConfirmation: ownerConfirmationEvidence
        });
    }
}

function resolveRoomNumber(request) {
    if (request.roomNumber == null || String(request.roomNumber).trim() === "") {
        throw new TypeError("roomNumber is required");
    }

    return normalizeRoomNumber(request.roomNumber);
}

function requireWallet(value, name) {
    if (typeof value !== "string" || !value.trim()) {
        throw new TypeError(`${name} is required`);
    }

    return value.trim();
}

function adoptedTransfer(payout) {
    return Object.freeze({
        ok: true,
        code: "ADOPTED",
        txHash: payout?.hash ?? payout?.txHash ?? null,
        amountNano: payout?.amountNano ?? null,
        destination: payout?.destination ?? null
    });
}

/**
 * Freezes the settlement payout plan into its JSON-persistable form.
 * Every nano value is a decimal string; the plan is self-describing
 * (policy mode, version, fee source, margin) and self-verifying on load
 * (see validatePersistedPayoutPlan).
 */
function buildPersistedPayoutPlan({
    winnerEntry,
    ownerEntry,
    ownerPlan,
    winnerWallet,
    ownerWallet,
    winnerFee,
    ownerFee,
    marginBps,
    marginFloorNano
}) {
    return Object.freeze({
        mode: PAYOUT_GAS_MODE.RECIPIENT_PAYS_GAS,
        gasPolicyVersion: PAYOUT_GAS_POLICY_VERSION,
        feeSource: ROOM_WALLET_PAYOUT_GAS_POLICY.feeSource,
        marginBps: marginBps.toString(10),
        marginFloorNano: nanoToPersistedString(marginFloorNano),
        winner: Object.freeze({
            role: "WINNER",
            destination: String(winnerWallet),
            grossPayoutNano: nanoToPersistedString(winnerEntry.grossPayoutNano),
            recipientGasChargeNano: nanoToPersistedString(winnerEntry.recipientGasChargeNano),
            recipientTransferAmountNano: nanoToPersistedString(winnerEntry.recipientTransferAmountNano),
            feeEvidence: Object.freeze({
                inFwdFeeNano: nanoToPersistedString(winnerFee.inFwdFeeNano),
                storageFeeNano: nanoToPersistedString(winnerFee.storageFeeNano),
                gasFeeNano: nanoToPersistedString(winnerFee.gasFeeNano),
                fwdFeeNano: nanoToPersistedString(winnerFee.fwdFeeNano),
                totalNano: nanoToPersistedString(winnerFee.totalNano)
            })
        }),
        owner: Object.freeze({
            role: "OWNER",
            destination: String(ownerWallet),
            ownerGrossNano: nanoToPersistedString(ownerPlan.ownerGrossNano),
            ownerRetainedNano: nanoToPersistedString(ownerPlan.retainedNano),
            ownerShareAfterRetentionNano: nanoToPersistedString(ownerPlan.ownerPayoutNano),
            grossPayoutNano: nanoToPersistedString(ownerEntry.grossPayoutNano),
            recipientGasChargeNano: nanoToPersistedString(ownerEntry.recipientGasChargeNano),
            recipientTransferAmountNano: nanoToPersistedString(ownerEntry.recipientTransferAmountNano),
            feeEvidence: Object.freeze({
                inFwdFeeNano: nanoToPersistedString(ownerFee.inFwdFeeNano),
                storageFeeNano: nanoToPersistedString(ownerFee.storageFeeNano),
                gasFeeNano: nanoToPersistedString(ownerFee.gasFeeNano),
                fwdFeeNano: nanoToPersistedString(ownerFee.fwdFeeNano),
                totalNano: nanoToPersistedString(ownerFee.totalNano)
            })
        })
    });
}

function parsePlanFeeEvidence(evidence, label) {
    const inFwdFeeNano = toPlanNano(evidence?.inFwdFeeNano, `${label}.inFwdFeeNano`);
    const storageFeeNano = toPlanNano(evidence?.storageFeeNano, `${label}.storageFeeNano`);
    const gasFeeNano = toPlanNano(evidence?.gasFeeNano, `${label}.gasFeeNano`);
    const fwdFeeNano = toPlanNano(evidence?.fwdFeeNano, `${label}.fwdFeeNano`);
    const totalNano = toPlanNano(evidence?.totalNano, `${label}.totalNano`);

    if (totalNano !== inFwdFeeNano + storageFeeNano + gasFeeNano + fwdFeeNano) {
        throw new TypeError(`${label}.feeEvidence total does not equal the sum of components`);
    }

    return { inFwdFeeNano, storageFeeNano, gasFeeNano, fwdFeeNano, totalNano };
}

/**
 * Strict shape validation of a persisted refund plan. Values are verified
 * arithmetically (margin recomputed from fee evidence, net = gross - charge)
 * so a corrupted plan fails closed before any refund broadcast. Matching an
 * entry to a concrete refund target additionally checks playerId, wallet and
 * the authoritative gross refundable amount (see findRefundPlanEntry).
 */
function validateRefundPlanShape(raw) {
    try {
        if (!raw || typeof raw !== "object") {
            return { ok: false, detail: "refundPlan is not an object" };
        }
        if (raw.mode !== PAYOUT_GAS_MODE.RECIPIENT_PAYS_GAS) {
            return { ok: false, detail: `refundPlan.mode=${String(raw.mode)}` };
        }
        if (raw.gasPolicyVersion !== PAYOUT_GAS_POLICY_VERSION) {
            return { ok: false, detail: `refundPlan.gasPolicyVersion=${String(raw.gasPolicyVersion)}` };
        }
        if (raw.feeSource !== ROOM_WALLET_PAYOUT_GAS_POLICY.feeSource) {
            return { ok: false, detail: `refundPlan.feeSource=${String(raw.feeSource)}` };
        }
        if (!Array.isArray(raw.entries)) {
            return { ok: false, detail: "refundPlan.entries is not an array" };
        }

        const marginBps = BigInt(String(raw.marginBps));
        const marginFloorNano = toPlanNano(raw.marginFloorNano, "refundPlan.marginFloorNano");
        if (marginBps < 0n) {
            return { ok: false, detail: "refundPlan.marginBps is negative" };
        }

        for (const entry of raw.entries) {
            if (!entry || typeof entry !== "object") {
                return { ok: false, detail: "refundPlan entry is missing" };
            }

            normalizeRefundQueryId(entry.queryId);
            const feeEvidence = parsePlanFeeEvidence(entry.feeEvidence, "refundPlan.entry");
            const gasCharge = toPlanNano(entry.recipientGasChargeNano, "entry.recipientGasChargeNano");
            const net = toPlanNano(entry.recipientTransferAmountNano, "entry.recipientTransferAmountNano");
            const gross = toPlanNano(entry.grossRefundNano, "entry.grossRefundNano");

            const marginComponent = feeEvidence.totalNano * marginBps / 10_000n;
            const expectedMargin = marginComponent > marginFloorNano
                ? marginComponent
                : marginFloorNano;

            if (gasCharge !== feeEvidence.totalNano + expectedMargin) {
                return { ok: false, detail: "entry.recipientGasChargeNano is inconsistent with its fee evidence" };
            }
            if (net !== gross - gasCharge) {
                return { ok: false, detail: "entry.recipientTransferAmountNano is inconsistent with gross minus gas charge" };
            }
        }

        return { ok: true, plan: raw };
    } catch (error) {
        return { ok: false, detail: error?.message ?? String(error) };
    }
}

function normalizeRefundQueryId(value) {
    if (value == null || value === "") {
        return null;
    }

    const text = String(value).trim();
    if (!/^\d+$/.test(text)) {
        throw new TypeError("refund queryId must be an unsigned decimal uint64");
    }

    const queryId = BigInt(text);
    if (queryId < 0n || queryId > 0xffffffffffffffffn) {
        throw new RangeError("refund queryId is outside uint64 range");
    }

    return queryId.toString(10);
}

function findRefundPlanEntry(plan, { target, wallet, amountNano }) {
    if (!plan || !Array.isArray(plan.entries)) {
        return null;
    }

    return plan.entries.find((entry) => {
        if (entry == null || typeof entry !== "object") {
            return false;
        }

        if (String(target?.playerId ?? "") !== String(entry.playerId ?? "")) {
            return false;
        }

        let targetQueryId;
        let entryQueryId;
        try {
            targetQueryId = normalizeRefundQueryId(target?.queryId);
            entryQueryId = normalizeRefundQueryId(entry.queryId);
        } catch {
            return false;
        }
        if (targetQueryId !== entryQueryId) {
            return false;
        }

        if (!planDestinationMatches(entry.wallet, wallet)) {
            return false;
        }

        try {
            return toPlanNano(entry.grossRefundNano, "entry.grossRefundNano") === amountNano;
        } catch {
            return false;
        }
    }) ?? null;
}

/**
 * Plan destination match: the frozen plan stores the destination string taken
 * from the authoritative request, so a byte-identical string always matches;
 * when both sides parse, the existing account-equality primitive additionally
 * accepts equivalent friendly-form spellings of the same account.
 */
function planDestinationMatches(stored, expected) {
    const storedValue = String(stored ?? "").trim();
    const expectedValue = String(expected ?? "").trim();

    if (!storedValue || !expectedValue) {
        return false;
    }

    if (storedValue === expectedValue) {
        return true;
    }

    return tonWalletAccountsEqual(storedValue, expectedValue);
}

/**
 * Strict validation of a persisted payout plan against the authoritative
 * settlement amounts and its own fee evidence. The margin and the gas charge
 * are RECOMPUTED from the persisted evidence: a plan is only accepted when
 * every persisted value is arithmetically consistent. This makes the frozen
 * plan tamper-evident without any re-estimation (deterministic recovery: the
 * accepted net values are exactly the persisted ones).
 *
 * Exported for the operator recovery module, which must validate the same
 * persisted plans with exactly the same rules (single validation authority).
 */
export function validatePersistedPayoutPlan(raw, {
    winnerAmountNano,
    ownerGrossNano,
    ownerPayoutNano,
    ownerRetainedNano,
    winnerWallet,
    ownerWallet
}) {
    try {
        if (!raw || typeof raw !== "object") {
            return { ok: false, detail: "payoutPlan is not an object" };
        }
        if (raw.mode !== PAYOUT_GAS_MODE.RECIPIENT_PAYS_GAS) {
            return { ok: false, detail: `payoutPlan.mode=${String(raw.mode)}` };
        }
        if (raw.gasPolicyVersion !== PAYOUT_GAS_POLICY_VERSION) {
            return { ok: false, detail: `payoutPlan.gasPolicyVersion=${String(raw.gasPolicyVersion)}` };
        }
        if (raw.feeSource !== ROOM_WALLET_PAYOUT_GAS_POLICY.feeSource) {
            return { ok: false, detail: `payoutPlan.feeSource=${String(raw.feeSource)}` };
        }

        const marginBps = BigInt(String(raw.marginBps));
        const marginFloorNano = toPlanNano(raw.marginFloorNano, "payoutPlan.marginFloorNano");
        if (marginBps < 0n) {
            return { ok: false, detail: "payoutPlan.marginBps is negative" };
        }

        const validateEntry = (entry, label, { expectedGrossNano, expectedDestination, extra = {} }) => {
            if (!entry || typeof entry !== "object") {
                throw new TypeError(`${label} entry is missing`);
            }
            if (entry.role !== label) {
                throw new TypeError(`${label}.role=${String(entry.role)}`);
            }

            const destinationRaw = String(entry.destination ?? "");
            // Address equality: byte-identical string (the plan freezes the
            // request's own destination string) or, when both parse, the
            // existing account-equality primitive.
            if (!planDestinationMatches(destinationRaw, expectedDestination)) {
                throw new TypeError(`${label}.destination mismatch`);
            }

            const feeEvidence = parsePlanFeeEvidence(entry.feeEvidence, label);
            const gasCharge = toPlanNano(entry.recipientGasChargeNano, `${label}.recipientGasChargeNano`);
            const net = toPlanNano(entry.recipientTransferAmountNano, `${label}.recipientTransferAmountNano`);
            const gross = toPlanNano(entry.grossPayoutNano, `${label}.grossPayoutNano`);

            if (gross !== expectedGrossNano) {
                throw new TypeError(
                    `${label}.grossPayoutNano=${gross} does not match authoritative ${expectedGrossNano}`
                );
            }

            const marginComponent = feeEvidence.totalNano * marginBps / 10_000n;
            const expectedMargin = marginComponent > marginFloorNano
                ? marginComponent
                : marginFloorNano;
            if (gasCharge !== feeEvidence.totalNano + expectedMargin) {
                throw new TypeError(`${label}.recipientGasChargeNano is inconsistent with its fee evidence`);
            }

            if (net <= 0n || gasCharge <= 0n) {
                throw new TypeError(`${label} net transfer or gas charge is not positive`);
            }
            if (net !== gross - gasCharge) {
                throw new TypeError(
                    `${label}.recipientTransferAmountNano is inconsistent with gross minus gas charge`
                );
            }

            const extraValidated = {};
            for (const [key, value] of Object.entries(extra)) {
                const parsed = toPlanNano(entry[key], `${label}.${key}`);
                if (parsed !== value) {
                    throw new TypeError(`${label}.${key} mismatch`);
                }
                extraValidated[key] = entry[key];
            }

            return Object.freeze({
                role: label,
                destination: destinationRaw,
                grossPayoutNano: gross,
                recipientGasChargeNano: gasCharge,
                recipientTransferAmountNano: net,
                feeEvidence: Object.freeze(feeEvidence),
                ...extraValidated
            });
        };

        const winner = validateEntry(raw.winner, "WINNER", {
            expectedGrossNano: winnerAmountNano,
            expectedDestination: winnerWallet
        });

        const owner = validateEntry(raw.owner, "OWNER", {
            expectedGrossNano: ownerPayoutNano,
            expectedDestination: ownerWallet,
            extra: {
                ownerGrossNano,
                ownerRetainedNano,
                ownerShareAfterRetentionNano: ownerPayoutNano
            }
        });

        return {
            ok: true,
            plan: Object.freeze({
                mode: raw.mode,
                gasPolicyVersion: raw.gasPolicyVersion,
                feeSource: raw.feeSource,
                marginBps: raw.marginBps,
                marginFloorNano: raw.marginFloorNano,
                winner,
                owner
            })
        };
    } catch (error) {
        return { ok: false, detail: error?.message ?? String(error) };
    }
}

function maskDestination(destination) {
    const value = String(destination ?? "");
    return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/**
 * Reads a plan value that may legitimately be a decimal string (persisted
 * plan form) or an already-parsed bigint (validated plan form returned by
 * validatePersistedPayoutPlan). Both forms carry identical values.
 */
function toPlanNano(value, name) {
    if (typeof value === "bigint") {
        return assertNonNegativeNano(value, name);
    }
    return parseNanoString(value, name);
}

function resolveCutoffUtime(request = {}) {
    const raw = request.cutoffUtime ?? request.timestamp ?? request.startedAt ?? null;
    if (raw == null || raw === "") {
        return null;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        return null;
    }
    return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
}

function createInspectTransport(roomWalletAdapter, roomNumber) {
    return {
        async getBalance() {
            return roomWalletAdapter.getBalance(roomNumber);
        },
        async getTransactions(_address, query) {
            if (typeof roomWalletAdapter.getTransactions !== "function") {
                return [];
            }
            return roomWalletAdapter.getTransactions(roomNumber, query);
        },
        async getSeqno() {
            if (typeof roomWalletAdapter.getSeqno !== "function") {
                return null;
            }
            return roomWalletAdapter.getSeqno(roomNumber);
        }
    };
}

function resolveNano(nanoValue, gramValue, name) {
    if (nanoValue != null) {
        if (typeof nanoValue !== "bigint") {
            throw new TypeError(`${name}Nano must be a bigint`);
        }
        return nanoValue;
    }

    if (typeof gramValue === "bigint") {
        return gramValue;
    }

    if (typeof gramValue === "number" && Number.isFinite(gramValue) && gramValue >= 0) {
        return BigInt(Math.round(gramValue * 1_000_000_000));
    }

    throw new TypeError(`${name} or ${name}Nano is required`);
}

/**
 * ContractSettlementManager handoff uses winnerAmount (GRAM).
 * Older adapter callers and s75 tests use prizeAmount / prizeAmountNano.
 * Both names are aliases of the same authoritative winner payout.
 * Disagreeing values fail closed.
 */
function resolveAuthoritativeWinnerAmountNano(request = {}) {
    const candidates = [];

    pushNanoCandidate(candidates, request.winnerAmountNano, "winnerAmountNano");
    pushNanoCandidate(candidates, request.prizeAmountNano, "prizeAmountNano");
    pushGramCandidate(candidates, request.winnerAmount, "winnerAmount");
    pushGramCandidate(candidates, request.prizeAmount, "prizeAmount");

    if (candidates.length === 0) {
        throw new TypeError("winnerAmount or winnerAmountNano is required");
    }

    const first = candidates[0].nano;

    for (const candidate of candidates) {
        if (candidate.nano !== first) {
            throw new TypeError(
                `winner amount fields disagree (${candidates[0].key} vs ${candidate.key})`
            );
        }
    }

    return first;
}

function pushNanoCandidate(candidates, value, key) {
    if (value == null) {
        return;
    }

    if (typeof value !== "bigint") {
        throw new TypeError(`${key} must be a bigint`);
    }

    candidates.push({ key, nano: value });
}

function pushGramCandidate(candidates, value, key) {
    if (value == null || value === "") {
        return;
    }

    if (typeof value === "bigint") {
        candidates.push({ key, nano: value });
        return;
    }

    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        candidates.push({
            key,
            nano: BigInt(Math.round(value * 1_000_000_000))
        });
        return;
    }

    throw new TypeError(`${key} must be a non-negative finite number or bigint`);
}
