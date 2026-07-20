import { GAME_STATES } from "../GameState";

import {
    PLAYER_UI_STATES,
    createDefaultPlayerRecord,
    isValidPlayerUIState,
    mapAuthoritativePlayerToPlayerUI,
    mapGameStateToPlayerUIState
} from "./PlayerState";

function clonePlayer(player) {

    return { ...player };

}

function samePlayerId(left, right) {

    if (left === null || left === undefined
        || right === null || right === undefined) {

        return false;

    }

    return String(left) === String(right);

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

    const next = [...engine._playerSnapshots.values()].sort((left, right) => {

        const seatLeft = left.seat;
        const seatRight = right.seat;

        if (seatLeft != null && seatRight != null && seatLeft !== seatRight) {

            return Number(seatLeft) - Number(seatRight);

        }

        return String(left.id).localeCompare(String(right.id));

    });

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

        rebuildAllSnapshots(this);

    }

    /**
     * Replace / merge identity from the authoritative roster.
     * Preserves activityState / online for players already present so
     * PLAYER_UPDATE and game-state sync are not wiped on roster refresh.
     */
    syncFromAuthoritativeRoster(authoritativePlayers = []) {

        const nextIds = new Set();

        for (const entry of authoritativePlayers) {

            const mapped = mapAuthoritativePlayerToPlayerUI(entry);

            if (!mapped) {

                continue;

            }

            nextIds.add(String(mapped.id));

            const storedId = this._resolveStoredId(mapped.id);

            const current = storedId != null
                ? this._players.get(storedId)
                : null;

            if (!current) {

                this._players.set(mapped.id, mapped);

                continue;

            }

            this._players.set(current.id, {
                ...current,
                nickname: mapped.nickname,
                icon: mapped.icon,
                color: mapped.color,
                wallet: mapped.wallet,
                seat: mapped.seat,
                status: mapped.status ?? current.status
            });

        }

        for (const id of [...this._players.keys()]) {

            if (!nextIds.has(String(id))) {

                this._players.delete(id);

            }

        }

        rebuildAllSnapshots(this);

        this._notify();

    }

    reset() {

        this._players.clear();

        rebuildAllSnapshots(this);

        this._notify();

    }

    getPlayers() {

        return this._playersListSnapshot;

    }

    getPlayer(id) {

        if (id === null || id === undefined) {

            return null;

        }

        return this._playerSnapshots.get(id)
            ?? this._playerSnapshots.get(String(id))
            ?? null;

    }

    _resolveStoredId(id) {

        if (this._players.has(id)) {

            return id;

        }

        const asString = String(id);

        if (this._players.has(asString)) {

            return asString;

        }

        for (const key of this._players.keys()) {

            if (samePlayerId(key, id)) {

                return key;

            }

        }

        return null;

    }

    setPlayerData(player) {

        this._validatePlayer(player);

        const current = this._players.get(player.id)
            ?? this._players.get(String(player.id));

        const next = createDefaultPlayerRecord({
            id: player.id,
            nickname: player.nickname,
            icon: player.icon,
            online: player.online ?? true,
            state: player.state ?? PLAYER_UI_STATES.READY,
            color: player.color ?? null,
            wallet: player.wallet ?? null,
            seat: player.seat ?? null,
            status: player.status ?? null
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

        const storedId = this._resolveStoredId(id);

        const player = storedId != null
            ? this._players.get(storedId)
            : null;

        if (!player) {

            return;

        }

        player.online = true;

        player.state = player.activityState || PLAYER_UI_STATES.READY;

        commitPlayerSnapshot(this, storedId);

        this._notifyPlayer(storedId);

    }

    setOffline(id) {

        const storedId = this._resolveStoredId(id);

        const player = storedId != null
            ? this._players.get(storedId)
            : null;

        if (!player) {

            return;

        }

        if (player.state !== PLAYER_UI_STATES.OFFLINE) {

            player.activityState = player.state;

        }

        player.online = false;

        player.state = PLAYER_UI_STATES.OFFLINE;

        commitPlayerSnapshot(this, storedId);

        this._notifyPlayer(storedId);

    }

    setState(id, state) {

        if (!isValidPlayerUIState(state)) {

            return;

        }

        const storedId = this._resolveStoredId(id);

        const player = storedId != null
            ? this._players.get(storedId)
            : null;

        if (!player) {

            return;

        }

        if (state === PLAYER_UI_STATES.OFFLINE) {

            this.setOffline(storedId);

            return;

        }

        player.activityState = state;

        if (player.online) {

            player.state = state;

        }

        commitPlayerSnapshot(this, storedId);

        this._notifyPlayer(storedId);

    }

    updatePlayer(partialPlayer) {

        const id = partialPlayer?.id ?? partialPlayer?.playerId;

        if (id === null || id === undefined || id === "") {

            return;

        }

        const storedId = this._resolveStoredId(id);

        const current = storedId != null
            ? this._players.get(storedId)
            : null;

        if (!current) {

            const mapped = mapAuthoritativePlayerToPlayerUI({
                ...partialPlayer,
                playerId: id
            });

            if (!mapped) {

                return;

            }

            this._players.set(mapped.id, mapped);

            commitPlayerSnapshot(this, mapped.id);

            this._notifyPlayer(mapped.id);

            return;

        }

        const next = {
            ...current,
            id: current.id
        };

        if (partialPlayer.nickname != null) {

            next.nickname = partialPlayer.nickname;

        }

        if (partialPlayer.icon != null) {

            next.icon = partialPlayer.icon;

        }

        if (partialPlayer.color !== undefined) {

            next.color = partialPlayer.color;

        }

        if (partialPlayer.wallet !== undefined) {

            next.wallet = partialPlayer.wallet;

        }

        if (partialPlayer.seat !== undefined
            || partialPlayer.seatIndex !== undefined) {

            next.seat = partialPlayer.seat ?? partialPlayer.seatIndex;

        }

        if (partialPlayer.status !== undefined) {

            next.status = partialPlayer.status;

        }

        if (partialPlayer.state && partialPlayer.state !== PLAYER_UI_STATES.OFFLINE) {

            next.activityState = partialPlayer.state;

        }

        if (partialPlayer.completedCycles !== undefined) {

            next.completedCycles = partialPlayer.completedCycles;

        }

        if (partialPlayer.remainingPresses !== undefined) {

            next.remainingPresses = partialPlayer.remainingPresses;

        }

        if (partialPlayer.buttonLocked !== undefined) {

            next.buttonLocked = partialPlayer.buttonLocked === true;

        }

        if (partialPlayer.pressed !== undefined) {

            next.pressed = partialPlayer.pressed === true;

        }

        if (partialPlayer.online !== undefined) {

            next.online = partialPlayer.online === true;

        }

        if (!next.online) {

            next.state = PLAYER_UI_STATES.OFFLINE;

        }

        this._players.set(current.id, next);

        commitPlayerSnapshot(this, current.id);

        this._notifyPlayer(current.id);

    }

    /**
     * P5.6B — Authoritative SPEED cycle / lock sync for player panels.
     */
    updateSpeedInput(payload = {}) {

        const playerId = payload.playerId;

        if (playerId === null || playerId === undefined || playerId === "") {

            return;

        }

        const completedCycles = payload.completedCycles ?? payload.pressCount ?? 0;

        const remainingPresses = payload.remainingPresses
            ?? Math.max(0, 3 - completedCycles);

        this.updatePlayer({
            playerId,
            completedCycles,
            remainingPresses,
            buttonLocked: payload.buttonLocked === true
                || payload.locked === true,
            pressed: payload.pressed === true
                || payload.buttonPressed === true
        });

    }

    applyGameResult(winnerId) {

        for (const [id, player] of this._players) {

            if (!player || !player.online) {

                continue;

            }

            const nextState = samePlayerId(id, winnerId)
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
                    icon: playerData.icon,
                    color: playerData.color,
                    wallet: playerData.wallet,
                    seat: playerData.seat
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

        for (const [id, player] of this._players) {

            if (!player || !player.online) {

                continue;

            }

            player.activityState = activityState;

            player.state = activityState;

            commitPlayerSnapshot(this, id);

            this._notifyPlayer(id);

        }

    }

    subscribe(listener) {

        this._listeners.add(listener);

        return () => {

            this._listeners.delete(listener);

        };

    }

    subscribePlayer(id, listener) {

        const wrapped = (players, changedId) => {

            if (changedId !== null && !samePlayerId(changedId, id)) {

                return;

            }

            const player = players.find(
                (entry) => samePlayerId(entry.id, id)
            ) || null;

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

            if (changedId === null || samePlayerId(changedId, id)) {

                onStoreChange();

            }

        };

        this._listeners.add(wrapped);

        return () => {

            this._listeners.delete(wrapped);

        };

    }

    _validatePlayer(player) {

        if (player?.id === null || player?.id === undefined || player?.id === "") {

            throw new Error("Player id is required");

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
