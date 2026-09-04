import {
    buildOwnerPayout,
    buildSourceWalletTransfer,
    assertNonNegativeNano
} from "./RoomWalletFinancialPolicy.js";
import { normalizeRoomNumber } from "./RoomWalletRegistry.js";

/**
 * Settlement adapter for the Room Wallet architecture.
 *
 * It consumes the already-calculated WheelWin settlement result. It does not
 * determine the winner, calculate the game pot, or change gameplay rules.
 * Winner and Owner receive their exact intended amounts; blockchain gas is
 * paid by the source Room Wallet.
 */
export class RoomWalletSettlementAdapter {
    constructor({ roomWalletAdapter, logger = null } = {}) {
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
    }

    async preflight(request = {}) {
        const roomNumber = resolveRoomNumber(request);
        const winnerAmountNano = resolveNano(request.prizeAmountNano, request.prizeAmount, "prizeAmount");
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

    async settleContract(request = {}) {
        const roomNumber = resolveRoomNumber(request);
        const winnerWallet = requireWallet(request.winnerWallet, "winnerWallet");
        const ownerWallet = requireWallet(request.ownerWallet, "ownerWallet");
        const winnerAmountNano = resolveNano(request.prizeAmountNano, request.prizeAmount, "prizeAmount");
        const ownerGrossNano = resolveNano(
            request.organizerAmountNano,
            request.organizerAmount,
            "organizerAmount"
        );
        const ownerPlan = buildOwnerPayout({ ownerGrossNano });
        const gasReserveNano = this._roomWalletAdapter.getGasReserveNano?.() ?? 0n;

        const preflight = await this.preflight(request);
        if (!preflight.ok) {
            return Object.freeze({
                ok: false,
                code: "INSUFFICIENT_ROOM_WALLET_BALANCE",
                roomNumber,
                preflight,
                winner: null,
                owner: null
            });
        }

        const winnerTransfer = buildSourceWalletTransfer({
            amountNano: winnerAmountNano,
            gasNano: gasReserveNano
        });

        const ownerTransfer = buildSourceWalletTransfer({
            amountNano: ownerPlan.ownerPayoutNano,
            gasNano: gasReserveNano
        });

        const winnerResult = await this._roomWalletAdapter.sendTransfer({
            roomNumber,
            destination: winnerWallet,
            amountNano: winnerAmountNano,
            queryId: request.winnerQueryId ?? null
        });

        if (!winnerResult?.ok) {
            return Object.freeze({
                ok: false,
                code: winnerResult?.code ?? "WINNER_PAYOUT_FAILED",
                roomNumber,
                winner: winnerResult,
                owner: null,
                winnerTransfer,
                ownerTransfer
            });
        }

        const ownerResult = await this._roomWalletAdapter.sendTransfer({
            roomNumber,
            destination: ownerWallet,
            amountNano: ownerPlan.ownerPayoutNano,
            queryId: request.ownerQueryId ?? null
        });

        if (!ownerResult?.ok) {
            this._logger?.error?.(
                `RoomWallet settlement partially completed | game=${request.gameId ?? "unknown"} `
                + `room=${roomNumber} | winnerTx=${winnerResult.txHash ?? "unknown"}`
            );

            return Object.freeze({
                ok: false,
                code: ownerResult?.code ?? "OWNER_PAYOUT_FAILED_AFTER_WINNER",
                partial: true,
                roomNumber,
                winner: winnerResult,
                owner: ownerResult,
                winnerTransfer,
                ownerTransfer,
                ownerRetainedNano: ownerPlan.retainedNano
            });
        }

        return Object.freeze({
            ok: true,
            code: "SETTLEMENT_BROADCAST",
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
