export const WALLET_CONNECTION_STATUS = Object.freeze({
    WAITING: "WAITING",
    CONNECTING: "CONNECTING",
    CONNECTED: "CONNECTED",
    ADDRESS_MISMATCH: "ADDRESS_MISMATCH"
});

/**
 * P6.2 — Per-room wallet connection session (Page4).
 * Connection only — no payments or contracts.
 */
export class WalletConnectionSession {

    constructor({
        roomId,
        players,
        createdAt = Date.now(),
        paymentConnectionReady = false
    }) {

        this.roomId = roomId;

        this.createdAt = createdAt;

        this.paymentConnectionReady = paymentConnectionReady === true;

        this.players = (players ?? []).map((player) => ({
            playerId: player.playerId,
            sessionWallet: player.sessionWallet ?? null,
            connectedWallet: player.connectedWallet ?? null,
            status: player.status ?? WALLET_CONNECTION_STATUS.WAITING
        }));

    }

    static createInitial(roomId, roster) {

        return new WalletConnectionSession({
            roomId,
            players: (roster ?? []).map((entry) => ({
                playerId: entry.playerId,
                sessionWallet: entry.sessionWallet ?? null,
                connectedWallet: null,
                status: WALLET_CONNECTION_STATUS.WAITING
            })),
            paymentConnectionReady: false
        });

    }

    findPlayer(playerId) {

        return this.players.find(
            (player) => String(player.playerId) === String(playerId)
        ) ?? null;

    }

    setConnecting(playerId) {

        const seat = this.findPlayer(playerId);

        if (!seat) {

            return false;

        }

        if (this.paymentConnectionReady) {

            return false;

        }

        seat.status = WALLET_CONNECTION_STATUS.CONNECTING;
        seat.connectedWallet = null;

        this.paymentConnectionReady = false;

        return true;

    }

    setConnected(playerId, connectedWallet) {

        const seat = this.findPlayer(playerId);

        if (!seat) {

            return false;

        }

        seat.connectedWallet = connectedWallet;
        seat.status = WALLET_CONNECTION_STATUS.CONNECTED;

        this.paymentConnectionReady = this.players.every(
            (player) => player.status === WALLET_CONNECTION_STATUS.CONNECTED
        );

        return true;

    }

    setAddressMismatch(playerId, connectedWallet) {

        const seat = this.findPlayer(playerId);

        if (!seat) {

            return false;

        }

        seat.connectedWallet = connectedWallet ?? null;
        seat.status = WALLET_CONNECTION_STATUS.ADDRESS_MISMATCH;

        this.paymentConnectionReady = false;

        return true;

    }

    setWaiting(playerId) {

        const seat = this.findPlayer(playerId);

        if (!seat) {

            return false;

        }

        seat.connectedWallet = null;
        seat.status = WALLET_CONNECTION_STATUS.WAITING;

        this.paymentConnectionReady = false;

        return true;

    }

    toSnapshot() {

        return Object.freeze({
            roomId: this.roomId,
            createdAt: this.createdAt,
            paymentConnectionReady: this.paymentConnectionReady,
            players: Object.freeze(
                this.players.map((player) => Object.freeze({
                    playerId: player.playerId,
                    sessionWallet: player.sessionWallet,
                    connectedWallet: player.connectedWallet,
                    status: player.status
                }))
            )
        });

    }

}
