import {
    buildOwnerPayout,
    buildSourceWalletTransfer,
    assertNonNegativeNano
} from "./RoomWalletFinancialPolicy.js";

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

        assertNonNegativeNano(winnerAmountNano, "winnerAmountNano");
        assertNonNegativeNano(ownerGrossNano, "ownerGrossNano");

        const ownerPlan = buildOwnerPayout({ ownerGrossNano });
        const winnerCheck = await this._roomWalletAdapter.canFundTransfer({
            roomNumber,
            amountNano: winnerAmountNano
        });
        const ownerCheck = await this._roomWalletAdapter.canFundTransfer({
            roomNumber,
            amountNano: ownerPlan.ownerPayoutNano
        });

        return Object.freeze({
            ok: winnerCheck.ok && ownerCheck.ok,
            roomNumber,
            winner: Object.freeze({
                amountNano: winnerAmountNano,
                balanceNano: winnerCheck.balanceNano,
                requiredNano: winnerCheck.requiredNano,
                shortfallNano: winnerCheck.shortfallNano
            }),
            owner: Object.freeze({
                grossNano: ownerGrossNano,
                payoutNano: ownerPlan.ownerPayoutNano,
                retainedNano: ownerPlan.retainedNano,
                balanceNano: ownerCheck.balanceNano,
                requiredNano: ownerCheck.requiredNano,
                shortfallNano: ownerCheck.shortfallNano
            })
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
            gasNano: this._roomWalletAdapter.getGasReserveNano?.() ?? 0n
        });

        const ownerTransfer = buildSourceWalletTransfer({
            amountNano: ownerPlan.ownerPayoutNano,
            gasNano: this._roomWalletAdapter.getGasReserveNano?.() ?? 0n
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
    const value = request.roomNumber ?? request.roomId;
    if (value == null || String(value).trim() === "") {
        throw new TypeError("roomNumber or roomId is required");
    }

    return String(value).trim();
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
