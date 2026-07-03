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

        return {
            [INCOMING_SOCKET_EVENTS.GAME_STATE]: (payload) => {

                modules.gameState?.onGameState?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.GAME_CLOCK_UPDATE]: (payload) => {

                modules.gameClock?.onClockUpdate?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.PLAYER_UPDATE]: (payload) => {

                modules.playerUI?.updatePlayer?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.PLAYER_ONLINE]: (payload) => {

                const playerId = payload?.playerId ?? payload?.id;

                if (playerId !== undefined) {

                    modules.playerUI?.setOnline?.(playerId);

                }

            },
            [INCOMING_SOCKET_EVENTS.PLAYER_OFFLINE]: (payload) => {

                const playerId = payload?.playerId ?? payload?.id;

                if (playerId !== undefined) {

                    modules.playerUI?.setOffline?.(playerId);

                }

            },
            [INCOMING_SOCKET_EVENTS.WHEEL_CONFIGURATION]: (payload) => {

                modules.wheel?.setConfiguration?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.PHYSICS_UPDATE]: (payload) => {

                modules.physics?.applyUpdate?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.GAME_RESULT]: (payload) => {

                modules.winnerResolver?.applyServerResult?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.PAYMENT_STARTED]: (payload) => {

                modules.payment?.onPaymentStarted?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.PAYMENT_COMPLETED]: (payload) => {

                modules.payment?.onPaymentCompleted?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.PAYMENT_FAILED]: (payload) => {

                modules.payment?.onPaymentFailed?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.AUDIT_STARTED]: (payload) => {

                modules.audit?.onAuditStarted?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.AUDIT_READY]: (payload) => {

                modules.audit?.onAuditReady?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.AUDIT_FAILED]: (payload) => {

                modules.audit?.onAuditFailed?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.GAME_START]: (payload) => {

                modules.audio?.onGameStart?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.GAME_END]: (payload) => {

                modules.audio?.onGameEnd?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.SESSION_SNAPSHOT]: (payload) => {

                modules.sessionRecovery?.handleSnapshot?.(payload);

            },
            [INCOMING_SOCKET_EVENTS.SESSION_RECOVERY_FAILED]: (payload) => {

                modules.sessionRecovery?.handleRecoveryFailed?.(payload);

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
