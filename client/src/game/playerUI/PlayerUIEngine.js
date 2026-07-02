import { GAME_STATES } from "../GameState";

import {
    PLAYER_COUNT,
    PLAYER_UI_STATES,
    createDefaultPlayerRecord,
    isValidPlayerUIState,
    mapGameStateToPlayerUIState
} from "./PlayerState";

import { DEFAULT_PLAYER_UI_DATA } from "./playerUIData";

function clonePlayer(player) {

    return { ...player };

}

function commitPlayerSnapshot(engine, id) {

    const player = engine._players.get(id);

    if (player) {

        engine._playerSnapshots.set(id, clonePlayer(player));

    } else {

        engine._playerSnapshots.delete(id);

    }

    rebuildPlayersListSnapshot(engine);

}

function rebuildPlayersListSnapshot(engine) {

    const next = [];

    for (let index = 1; index <= PLAYER_COUNT; index += 1) {

        const snapshot = engine._playerSnapshots.get(index);

        if (snapshot) {

            next.push(snapshot);

        }

    }

    engine._playersListSnapshot = next;

}

function rebuildAllSnapshots(engine) {

    engine._playerSnapshots.clear();

    for (const [id, player] of engine._players) {

        engine._playerSnapshots.set(id, clonePlayer(player));

    }

    rebuildPlayersListSnapshot(engine);

}

export class PlayerUIEngine {

    constructor() {

        this._players = new Map();

        this._playerSnapshots = new Map();

        this._playersListSnapshot = [];

        this._listeners = new Set();

        this._initializeDefaults();

        rebuildAllSnapshots(this);

    }

    _initializeDefaults() {

        DEFAULT_PLAYER_UI_DATA.forEach((player) => {

            this._players.set(player.id, clonePlayer(player));

        });

    }

    reset() {

        this._players.clear();

        this._initializeDefaults();

        rebuildAllSnapshots(this);

        this._notify();

    }

    getPlayers() {

        return this._playersListSnapshot;

    }

    getPlayer(id) {

        return this._playerSnapshots.get(id) ?? null;

    }

    setPlayerData(player) {

        this._validatePlayer(player);

        const current = this._players.get(player.id);

        const next = createDefaultPlayerRecord({
            id: player.id,
            nickname: player.nickname,
            icon: player.icon,
            online: player.online ?? true,
            state: player.state ?? PLAYER_UI_STATES.READY
        });

        if (current && !player.online) {

            next.activityState = current.activityState;

        } else if (player.state && player.state !== PLAYER_UI_STATES.OFFLINE) {

            next.activityState = player.state;

        }

        this._players.set(player.id, next);

        commitPlayerSnapshot(this, player.id);

        this._notifyPlayer(player.id);

    }

    setOnline(id) {

        const player = this._players.get(id);

        if (!player) {

            return;

        }

        player.online = true;

        player.state = player.activityState || PLAYER_UI_STATES.READY;

        commitPlayerSnapshot(this, id);

        this._notifyPlayer(id);

    }

    setOffline(id) {

        const player = this._players.get(id);

        if (!player) {

            return;

        }

        if (player.state !== PLAYER_UI_STATES.OFFLINE) {

            player.activityState = player.state;

        }

        player.online = false;

        player.state = PLAYER_UI_STATES.OFFLINE;

        commitPlayerSnapshot(this, id);

        this._notifyPlayer(id);

    }

    setState(id, state) {

        if (!isValidPlayerUIState(state)) {

            return;

        }

        const player = this._players.get(id);

        if (!player) {

            return;

        }

        if (state === PLAYER_UI_STATES.OFFLINE) {

            this.setOffline(id);

            return;

        }

        player.activityState = state;

        if (player.online) {

            player.state = state;

        }

        commitPlayerSnapshot(this, id);

        this._notifyPlayer(id);

    }

    updatePlayer(partialPlayer) {

        if (!partialPlayer?.id) {

            return;

        }

        const current = this._players.get(partialPlayer.id);

        if (!current) {

            return;

        }

        const next = {
            ...current,
            ...partialPlayer
        };

        if (partialPlayer.state && partialPlayer.state !== PLAYER_UI_STATES.OFFLINE) {

            next.activityState = partialPlayer.state;

        }

        if (!next.online) {

            next.state = PLAYER_UI_STATES.OFFLINE;

        }

        this._players.set(partialPlayer.id, next);

        commitPlayerSnapshot(this, partialPlayer.id);

        this._notifyPlayer(partialPlayer.id);

    }

    applyGameResult(winnerId) {

        for (let id = 1; id <= PLAYER_COUNT; id += 1) {

            const player = this._players.get(id);

            if (!player || !player.online) {

                continue;

            }

            const nextState = id === winnerId
                ? PLAYER_UI_STATES.WIN
                : PLAYER_UI_STATES.LOST;

            player.activityState = nextState;

            player.state = nextState;

            commitPlayerSnapshot(this, id);

            this._notifyPlayer(id);

        }

    }

    restoreSessionSnapshot(snapshot = {}) {

        const playerStates = snapshot.playerStates || [];

        playerStates.forEach((playerData) => {

            const id = playerData?.id ?? playerData?.playerId;

            if (!id) {

                return;

            }

            if (playerData.nickname || playerData.icon) {

                this.updatePlayer({
                    id,
                    nickname: playerData.nickname,
                    icon: playerData.icon
                });

            }

            if (playerData.online === false) {

                this.setOffline(id);

                return;

            }

            this.setOnline(id);

            if (playerData.state) {

                this.setState(id, playerData.state);

            }

        });

    }

    syncWithGameState(gameState, resultOutcome = null) {

        if (gameState === GAME_STATES.RESULT) {

            return;

        }

        const activityState = mapGameStateToPlayerUIState(
            gameState,
            resultOutcome
        );

        for (let id = 1; id <= PLAYER_COUNT; id += 1) {

            const player = this._players.get(id);

            if (!player || !player.online) {

                continue;

            }

            let nextState = activityState;

            if (gameState === GAME_STATES.RESULT) {

                nextState = id === 1
                    ? activityState
                    : (
                        activityState === PLAYER_UI_STATES.WIN
                            ? PLAYER_UI_STATES.LOST
                            : PLAYER_UI_STATES.WIN
                    );

            }

            player.activityState = nextState;

            player.state = nextState;

            commitPlayerSnapshot(this, id);

            this._notifyPlayer(id);

        }

    }

    subscribe(listener) {

        this._listeners.add(listener);

        listener(this.getPlayers());

        return () => {

            this._listeners.delete(listener);

        };

    }

    subscribePlayer(id, listener) {

        const wrapped = (players, changedId) => {

            if (changedId !== null && changedId !== id) {

                return;

            }

            const player = players.find((entry) => entry.id === id) || null;

            listener(player);

        };

        this._listeners.add(wrapped);

        listener(this.getPlayer(id));

        return () => {

            this._listeners.delete(wrapped);

        };

    }

    subscribePlayerChanges(id, onStoreChange) {

        const wrapped = (players, changedId) => {

            if (changedId === null || changedId === id) {

                onStoreChange();

            }

        };

        this._listeners.add(wrapped);

        return () => {

            this._listeners.delete(wrapped);

        };

    }

    _validatePlayer(player) {

        if (!player?.id || player.id < 1 || player.id > PLAYER_COUNT) {

            throw new Error(`Player id must be between 1 and ${PLAYER_COUNT}`);

        }

        if (typeof player.nickname !== "string") {

            throw new Error("Player nickname must be a string");

        }

        if (typeof player.icon !== "string") {

            throw new Error("Player icon must be a string");

        }

    }

    _notifyPlayer(id) {

        const players = this.getPlayers();

        this._listeners.forEach((listener) => {

            listener(players, id);

        });

    }

    _notify() {

        const players = this.getPlayers();

        this._listeners.forEach((listener) => {

            listener(players, null);

        });

    }

}

