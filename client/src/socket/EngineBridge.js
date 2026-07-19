import { INCOMING_SOCKET_EVENTS } from "./socketEvents";

export class EngineBridge {

    constructor() {

        this._modules = {};

    }

    register(moduleName, api) {

        this._modules[moduleName] = api;

        return () => {

            delete this._modules[moduleName];

        };

    }

    getModules() {

        return this._modules;

    }

    createDispatcherHandlers() {

        const modules = this._modules;

        // C5.2 — Additive fan-out to the authoritative session mirror.
        // Existing module handlers are unchanged; the session module only
        // observes. No second socket listener is introduced.
        const session = () => modules.authoritativeSession;

        return {
            [INCOMING_SOCKET_EVENTS.GAME_STATE]: (payload) => {

                modules.gameState?.onGameState?.(payload);

                session()?.onGameState?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.GAME_CLOCK_UPDATE]: (payload) => {

                modules.gameClock?.onClockUpdate?.(payload);

                session()?.onClockUpdate?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.PLAYER_UPDATE]: (payload) => {

                session()?.onPlayerUpdate?.(payload);

                modules.playerUI?.updatePlayer?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.PLAYER_ONLINE]: (payload) => {

                const playerId = payload?.playerId ?? payload?.id;

                if (playerId !== undefined) {

                    modules.playerUI?.setOnline?.(playerId);

                }

                session()?.onPlayerOnline?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.PLAYER_OFFLINE]: (payload) => {

                const playerId = payload?.playerId ?? payload?.id;

                if (playerId !== undefined) {

                    modules.playerUI?.setOffline?.(playerId);

                }

                session()?.onPlayerOffline?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.WHEEL_CONFIGURATION]: (payload) => {

                modules.wheel?.setConfiguration?.(payload);

                session()?.onWheelConfiguration?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.PHYSICS_UPDATE]: (payload) => {

                modules.physics?.applyUpdate?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.GAME_RESULT]: (payload) => {

                modules.winnerResolver?.applyServerResult?.(payload);

                session()?.onGameResult?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.PAYMENT_STARTED]: (payload) => {

                modules.payment?.onPaymentStarted?.(payload);

                session()?.onPayment?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.PAYMENT_COMPLETED]: (payload) => {

                modules.payment?.onPaymentCompleted?.(payload);

                session()?.onPayment?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.PAYMENT_FAILED]: (payload) => {

                modules.payment?.onPaymentFailed?.(payload);

                session()?.onPayment?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.AUDIT_STARTED]: (payload) => {

                modules.audit?.onAuditStarted?.(payload);

                session()?.onAudit?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.AUDIT_READY]: (payload) => {

                modules.audit?.onAuditReady?.(payload);

                session()?.onAudit?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.AUDIT_FAILED]: (payload) => {

                modules.audit?.onAuditFailed?.(payload);

                session()?.onAudit?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.GAME_START]: (payload) => {

                modules.audio?.onGameStart?.(payload);

                session()?.onGameStart?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.GAME_END]: (payload) => {

                modules.audio?.onGameEnd?.(payload);

                session()?.onGameEnd?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.SETUP_SESSION_STARTED]: (payload) => {

                session()?.onSetupSession?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.SETUP_SESSION_SYNC]: (payload) => {

                session()?.onSetupSession?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.SETUP_SESSION_EXPIRED]: (payload) => {

                session()?.onSetupSessionExpired?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.VERIFY_COMPLETED]: (payload) => {

                session()?.onVerifyCompleted?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.PAYMENT_STAGE_READY]: (payload) => {

                session()?.onPaymentStageReady?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.SESSION_SNAPSHOT]: (payload) => {

                modules.sessionRecovery?.handleSnapshot?.(payload);

                session()?.onSessionSnapshot?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.SESSION_RECOVERY_FAILED]: (payload) => {

                modules.sessionRecovery?.handleRecoveryFailed?.(payload);

                session()?.onSessionRecoveryFailed?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.PLAYER_INPUT_ACCEPTED]: (payload) => {

                modules.inputAck?.onInputAccepted?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.PLAYER_INPUT_REJECTED]: (payload) => {

                modules.inputAck?.onInputRejected?.(payload);

            }
        };

    }

}
