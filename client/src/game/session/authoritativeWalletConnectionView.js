/**
 * P6.2 — Authoritative wallet connection view helpers for Page4.
 */

import { resolveWheelIcon } from "../../components/game/WheelEngine/wheelUtils.js";

export const WALLET_CONNECTION_STATUS = Object.freeze({
    WAITING: "WAITING",
    CONNECTING: "CONNECTING",
    CONNECTED: "CONNECTED",
    ADDRESS_MISMATCH: "ADDRESS_MISMATCH"
});

function resolveDisplayIcon(icon) {

    if (icon == null || icon === "" || icon === "—") {

        return "—";

    }

    return resolveWheelIcon(icon);

}

export function hasWalletConnectionSession(walletConnection) {

    return Array.isArray(walletConnection?.players)
        && walletConnection.players.length > 0;

}

export function shouldShowWalletConnectionWaiting(walletConnection) {

    return !hasWalletConnectionSession(walletConnection);

}

export function mapWalletConnectionStatusLabel(status) {

    switch (status) {

        case WALLET_CONNECTION_STATUS.CONNECTING:
            return "payment.statusConnecting";

        case WALLET_CONNECTION_STATUS.CONNECTED:
            return "payment.statusConnected";

        case WALLET_CONNECTION_STATUS.ADDRESS_MISMATCH:
            return "payment.statusAddressMismatch";

        case WALLET_CONNECTION_STATUS.WAITING:
        default:
            return "payment.statusWaiting";

    }

}

export function mapWalletConnectionRows(walletConnection, playersById = {}) {

    if (!Array.isArray(walletConnection?.players)) {

        return [];

    }

    return walletConnection.players.map((seat, index) => {

        const roster = playersById?.[seat.playerId] ?? null;

        return {
            key: seat.playerId ?? `wallet-${index}`,
            playerId: seat.playerId,
            labelTitle: index === 0
                ? "player.yourNickname"
                : "player.playerNickname",
            nickname: roster?.nickname ?? "—",
            icon: resolveDisplayIcon(roster?.icon),
            sessionWallet: seat.sessionWallet ?? null,
            connectedWallet: seat.connectedWallet ?? null,
            status: seat.status ?? WALLET_CONNECTION_STATUS.WAITING,
            statusLabel: mapWalletConnectionStatusLabel(seat.status)
        };

    });

}
