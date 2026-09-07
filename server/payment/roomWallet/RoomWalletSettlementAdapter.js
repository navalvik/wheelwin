import {
    buildOwnerPayout,
    buildSourceWalletTransfer,
    assertNonNegativeNano
} from "./RoomWalletFinancialPolicy.js";
import { normalizeRoomNumber } from "./RoomWalletRegistry.js";
import { inspectRoomWalletHistory } from "./roomWalletTerminalRecoveryChain.js";

export const ROOM_WALLET_SETTLEMENT_SAFETY_CODES = Object.freeze({
    WALLET_REUSED: "WALLET_REUSED",
    DUPLICATE_PAYOUT: "DUPLICATE_PAYOUT",
    AMOUNT_MISMATCH: "AMOUNT_MISMATCH"
});

export const ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES = Object.freeze({
    CHAIN_INSPECT_UNKNOWN: "CHAIN_INSPECT_UNKNOWN",
    UNCERTAIN_BROADCAST: "UNCERTAIN_BROADCAST",
    INSUFFICIENT_ROOM_WALLET_BALANCE: "INSUFFICIENT_ROOM_WALLET_BALANCE",
    WINNER_PAYOUT_FAILED: "WINNER_PAYOUT_FAILED",
    OWNER_PAYOUT_FAILED_AFTER_WINNER: "OWNER_PAYOUT_FAILED_AFTER_WINNER",
    ADAPTER_THREW: "ADAPTER_THREW"
});

/**
 * Settlement adapter for the Room Wallet architecture.
 *
 * It consumes the already-calculated WheelWin settlement result. It does not
 * determine the winner, calculate the game pot, or change gameplay rules.
 * Winner and Owner receive their exact intended amounts; blockchain gas is
 * paid by the source Room Wallet.
 *
 * Authoritative ContractSettlementManager handoff fields:
 * winnerAmount, organizerAmount, roomNumber, winnerWallet, ownerWallet.
 * prizeAmount / prizeAmountNano remain aliases of the winner payout.
 */
export class RoomWalletSettlementAdapter {
    constructor({
        roomWalletAdapter,
        logger = null,
        inspectHistory = inspectRoomWalletHistory
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

        this._roomWalletAdapter = roomWalletAdapter;
        this._logger = logger;
        this._inspectHistory = inspectHistory;
    }

    async preflight(request = {}) {
        const roomNumber = resolveRoomNumber(request);
        const winnerAmountNano = resolveAuthoritativeWinnerAmountNano(request);
        const ownerGrossNano = resolveNano(
            request.organizerAmountNano,
            request.organizerAmount,
            "organizerAmount"
        );
        const gasReserveNano = this._roomWalletAdapter.getGasReserveNano?.() ?? 0n;

        assertNonNegativeNano(winnerAmountNano, "winnerAmountNano");
        assertNonNegativeNano(ownerGrossNano, "ownerGrossNano");
        assertNonNegativeNano(gasReserveNano, "gasReserveNano");

        const ownerPlan = buildOwnerPayout({ ownerGrossNano });
        const balanceNano = await this._roomWalletAdapter.getBalance(roomNumber);
        const totalPayoutNano = winnerAmountNano + ownerPlan.ownerPayoutNano;
        const totalGasReserveNano = gasReserveNano * 2n;
        const requiredNano = totalPayoutNano + totalGasReserveNano;

        return Object.freeze({
            ok: balanceNano >= requiredNano,
            roomNumber,
            balanceNano,
            winner: Object.freeze({
                amountNano: winnerAmountNano,
                gasReserveNano,
                requiredNano: winnerAmountNano + gasReserveNano
            }),
            owner: Object.freeze({
                grossNano: ownerGrossNano,
                payoutNano: ownerPlan.ownerPayoutNano,
                retainedNano: ownerPlan.retainedNano,
                gasReserveNano,
                requiredNano: ownerPlan.ownerPayoutNano + gasReserveNano
            }),
            totalPayoutNano,
            totalGasReserveNano,
            requiredNano,
            shortfallNano: balanceNano >= requiredNano
                ? 0n
                : requiredNano - balanceNano
        });
    }

    async inspectSettlement(request = {}) {
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

        try {
            const history = await this._inspectHistory({
                tonService: createInspectTransport(this._roomWalletAdapter, roomNumber),
                roomWalletAddress,
                cutoffLt: request.cutoffLt ?? null,
                cutoffUtime: resolveCutoffUtime(request),
                winnerWallet,
                ownerWallet,
                winnerAmountNano,
                ownerAmountNano: ownerPlan.ownerPayoutNano
            });
            return Object.freeze({
                unavailable: false,
                unknown: false,
                roomNumber,
                roomWalletAddress,
                winnerAmountNano,
                ownerPayoutNano: ownerPlan.ownerPayoutNano,
                ownerRetainedNano: ownerPlan.retainedNano,
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
        const gasReserveNano = this._roomWalletAdapter.getGasReserveNano?.() ?? 0n;
        const winnerTransfer = buildSourceWalletTransfer({
            amountNano: winnerAmountNano,
            gasNano: gasReserveNano
        });
        const ownerTransfer = buildSourceWalletTransfer({
            amountNano: ownerPlan.ownerPayoutNano,
            gasNano: gasReserveNano
        });

        const history = await this.inspectSettlement(request);
        if (history?.unknown === true) {
            return Object.freeze({
                ok: false,
                retryable: true,
                chainInspected: true,
                code: ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.CHAIN_INSPECT_UNKNOWN,
                roomNumber,
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
                    winnerTransfer,
                    ownerTransfer
                });
            }
        }

        const needWinner = !(history && history.unavailable !== true && history.winnerPayout);
        const needOwner = !(history && history.unavailable !== true && history.ownerPayout);

        if (needWinner || needOwner) {
            const preflight = await this.preflight(request);
            if (!preflight.ok) {
                return Object.freeze({
                    ok: false,
                    retryable: true,
                    chainInspected: history?.unavailable !== true,
                    code: ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.INSUFFICIENT_ROOM_WALLET_BALANCE,
                    roomNumber,
                    preflight,
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

        if (needWinner) {
            winnerResult = await this._roomWalletAdapter.sendTransfer({
                roomNumber,
                destination: winnerWallet,
                amountNano: winnerAmountNano,
                queryId: request.winnerQueryId ?? null
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
                    winnerTransfer,
                    ownerTransfer
                });
            }
        }

        if (needOwner) {
            ownerResult = await this._roomWalletAdapter.sendTransfer({
                roomNumber,
                destination: ownerWallet,
                amountNano: ownerPlan.ownerPayoutNano,
                queryId: request.ownerQueryId ?? null
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
                    winnerTransfer,
                    ownerTransfer,
                    ownerRetainedNano: ownerPlan.retainedNano
                });
            }
        }

        const afterSend = history?.unavailable === true
            ? null
            : await this.inspectSettlement(request);

        if (afterSend?.unknown === true) {
            return Object.freeze({
                ok: false,
                retryable: true,
                chainInspected: true,
                code: ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.UNCERTAIN_BROADCAST,
                roomNumber,
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
                    winnerTransfer,
                    ownerTransfer
                });
            }
            return Object.freeze({
                ok: false,
                retryable: true,
                chainInspected: true,
                code: ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.UNCERTAIN_BROADCAST,
                roomNumber,
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
            winnerTransfer,
            ownerTransfer
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
