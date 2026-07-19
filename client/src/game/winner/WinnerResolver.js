import { LOCAL_OUTCOMES } from "./winnerEvents";

import {
    buildWinnerConfiguration,
    buildWinnerPlayer,
    buildWinningSector,
    findWinningSectorIndex,
    resolveLocalOutcome
} from "./winnerUtils";

export class WinnerResolver {

    constructor() {

        this._resolved = false;

        this._result = null;

        this._localPlayerId = null;

    }

    reset() {

        this._resolved = false;

        this._result = null;

    }

    setLocalPlayerId(playerId) {

        this._localPlayerId = playerId;

    }

    resolveWinner({
        wheelAngle,
        triangleAngle,
        configuration,
        players,
        localPlayerId = this._localPlayerId
    }) {

        if (this._resolved) {

            return this._result;

        }

        const gameConfiguration = buildWinnerConfiguration(configuration, players);

        const sectorCount = gameConfiguration.sectors.length;

        const winningSectorIndex = findWinningSectorIndex(
            wheelAngle,
            triangleAngle,
            sectorCount
        );

        const winningSectorConfig = gameConfiguration.sectors[winningSectorIndex];

        const winningSector = buildWinningSector(
            winningSectorConfig,
            winningSectorIndex
        );

        const winnerRecord = gameConfiguration.players.find(
            (player) => String(player.id) === String(winningSectorConfig.playerId)
        ) || null;

        const winner = buildWinnerPlayer(winnerRecord, winningSector);

        const localOutcome = resolveLocalOutcome(
            winner?.id ?? null,
            localPlayerId
        );

        this._result = {
            winner,
            winningSector,
            finalWheelAngle: wheelAngle,
            finalTriangleAngle: triangleAngle,
            localOutcome
        };

        this._resolved = true;

        return this._result;

    }

    applyServerResult(payload) {

        if (!payload?.winner || !payload?.winningSector) {

            return null;

        }

        const localOutcome = payload.localOutcome
            ?? resolveLocalOutcome(
                payload.winner.id,
                this._localPlayerId
            );

        this._result = {
            winner: payload.winner,
            winningSector: payload.winningSector,
            finalWheelAngle: payload.finalWheelAngle ?? payload.wheelAngle ?? 0,
            finalTriangleAngle: payload.finalTriangleAngle
                ?? payload.triangleAngle
                ?? 0,
            localOutcome
        };

        this._resolved = true;

        return this._result;

    }

    getWinner() {

        return this._result?.winner ?? null;

    }

    getWinningSector() {

        return this._result?.winningSector ?? null;

    }

    generateResult() {

        if (!this._result) {

            return null;

        }

        return {
            winner: this._result.winner,
            winningSector: this._result.winningSector,
            finalWheelAngle: this._result.finalWheelAngle,
            finalTriangleAngle: this._result.finalTriangleAngle
        };

    }

    getLocalOutcome() {

        return this._result?.localOutcome ?? null;

    }

    isResolved() {

        return this._resolved;

    }

    isLocalWin() {

        return this._result?.localOutcome === LOCAL_OUTCOMES.WIN;

    }

    isLocalLoss() {

        return this._result?.localOutcome === LOCAL_OUTCOMES.LOSE;

    }

}
