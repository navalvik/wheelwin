/**
 * R17.9L.3 — DepositSession validation helpers (no TON, no chain).
 */

import {
    InvalidDepositBindingError,
    InvalidDepositFundingError,
    InvalidDepositIdentityError
} from "./DepositSessionErrors.js";

export const REQUIRED_DEPOSIT_PLAYER_COUNT = 3;

export function normalizeDepositIdPart(value) {

    if (typeof value !== "string") {

        return "";

    }

    return value.trim();

}

export function normalizeDepositWallet(wallet) {

    if (typeof wallet !== "string") {

        return "";

    }

    return wallet.trim();

}

export function assertDepositIdentity({ roomId, gameId, roomExists = null, gameExists = null } = {}) {

    const room = normalizeDepositIdPart(roomId);

    if (!room) {

        throw new InvalidDepositIdentityError("roomId is required", { roomId });

    }

    const game = normalizeDepositIdPart(gameId);

    if (!game) {

        throw new InvalidDepositIdentityError("gameId is required", { gameId });

    }

    if (typeof roomExists === "function" && !roomExists(room)) {

        throw new InvalidDepositIdentityError("roomId does not exist", { roomId: room });

    }

    if (typeof gameExists === "function" && !gameExists(game)) {

        throw new InvalidDepositIdentityError("gameId does not exist", { gameId: game });

    }

    return { roomId: room, gameId: game };

}

export function assertPlayerBindings(rawPlayers, { roomId, gameId } = {}) {

    if (!Array.isArray(rawPlayers)) {

        throw new InvalidDepositBindingError("players must be an array", {
            roomId,
            gameId
        });

    }

    if (rawPlayers.length !== REQUIRED_DEPOSIT_PLAYER_COUNT) {

        throw new InvalidDepositBindingError(
            `Deposit binding requires exactly ${REQUIRED_DEPOSIT_PLAYER_COUNT} players`,
            { roomId, gameId, playerCount: rawPlayers.length }
        );

    }

    const wallets = new Set();
    const playerIds = new Set();
    const bindings = [];

    for (const raw of rawPlayers) {

        const playerId = normalizeDepositIdPart(raw?.playerId);
        const wallet = normalizeDepositWallet(raw?.wallet ?? raw?.walletAddress);
        const expectedAmount = Number(raw?.expectedAmount);

        if (!playerId) {

            throw new InvalidDepositBindingError("Each player must include playerId", {
                roomId,
                gameId
            });

        }

        if (playerIds.has(playerId)) {

            throw new InvalidDepositBindingError("Duplicate playerId in deposit binding", {
                roomId,
                gameId,
                playerId
            });

        }

        if (!wallet) {

            throw new InvalidDepositBindingError("Each player must include a wallet", {
                roomId,
                gameId,
                playerId
            });

        }

        if (wallets.has(wallet)) {

            throw new InvalidDepositBindingError("Duplicate wallet in deposit binding", {
                roomId,
                gameId,
                wallet
            });

        }

        if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {

            throw new InvalidDepositBindingError("Each player must include a positive expectedAmount", {
                roomId,
                gameId,
                playerId,
                expectedAmount: raw?.expectedAmount
            });

        }

        playerIds.add(playerId);
        wallets.add(wallet);

        bindings.push(Object.freeze({
            playerId,
            wallet,
            expectedAmount,
            receivedAmount: 0,
            funded: false,
            fundingEventId: null,
            fundedAt: null
        }));

    }

    return Object.freeze(bindings);

}

export function assertFundingEvent(session, { wallet, amount, fundingEventId }) {

    if (!session?.bindings?.length) {

        throw new InvalidDepositFundingError("Deposit has no player bindings", {
            depositId: session?.depositId
        });

    }

    const eventId = normalizeDepositIdPart(fundingEventId);

    if (!eventId) {

        throw new InvalidDepositFundingError("fundingEventId is required", {
            depositId: session.depositId
        });

    }

    if (session.fundingEventIds.includes(eventId)) {

        throw new InvalidDepositFundingError("Duplicate funding event", {
            depositId: session.depositId,
            fundingEventId: eventId
        });

    }

    const normalizedWallet = normalizeDepositWallet(wallet);

    if (!normalizedWallet) {

        throw new InvalidDepositFundingError("Funding wallet is required", {
            depositId: session.depositId
        });

    }

    const seat = session.bindings.find((binding) => binding.wallet === normalizedWallet);

    if (!seat) {

        throw new InvalidDepositFundingError("Unknown wallet cannot fund deposit", {
            depositId: session.depositId,
            wallet: normalizedWallet
        });

    }

    if (seat.funded) {

        throw new InvalidDepositFundingError("Duplicate funding event", {
            depositId: session.depositId,
            wallet: normalizedWallet,
            playerId: seat.playerId
        });

    }

    const incoming = Number(amount);

    if (!Number.isFinite(incoming) || incoming <= 0) {

        throw new InvalidDepositFundingError("Funding amount must be a positive number", {
            depositId: session.depositId,
            wallet: normalizedWallet,
            amount
        });

    }

    if (incoming > seat.expectedAmount) {

        throw new InvalidDepositFundingError("Funded amount cannot exceed expected amount", {
            depositId: session.depositId,
            wallet: normalizedWallet,
            expectedAmount: seat.expectedAmount,
            amount: incoming
        });

    }

    if (incoming !== seat.expectedAmount) {

        throw new InvalidDepositFundingError("Funding amount must equal expected amount", {
            depositId: session.depositId,
            wallet: normalizedWallet,
            expectedAmount: seat.expectedAmount,
            amount: incoming
        });

    }

    return { seat, eventId, amount: incoming, wallet: normalizedWallet };

}
