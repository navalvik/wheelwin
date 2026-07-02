const TWO_PI = Math.PI * 2;

const WHEEL_ORIGIN_RADIANS = -Math.PI / 2;

export function degreesToRadians(degrees) {

    return degrees * (Math.PI / 180);

}

export function pointerAngleFromDegrees(angleDegrees) {

    return degreesToRadians(angleDegrees) + WHEEL_ORIGIN_RADIANS;

}

export function normalizeRadians(angleRadians) {

    let normalized = angleRadians % TWO_PI;

    if (normalized < 0) {

        normalized += TWO_PI;

    }

    return normalized;

}

export function getSectorAngleRadians(sectorCount) {

    if (!Number.isFinite(sectorCount) || sectorCount <= 0) {

        throw new Error("Sector count must be a positive number");

    }

    return TWO_PI / sectorCount;

}

export function findWinningSectorIndex(
    wheelAngleDegrees,
    triangleAngleDegrees,
    sectorCount
) {

    const sectorAngle = getSectorAngleRadians(sectorCount);

    const pointerRadians = pointerAngleFromDegrees(triangleAngleDegrees);

    const wheelStartRadians = WHEEL_ORIGIN_RADIANS
        + degreesToRadians(wheelAngleDegrees);

    const localAngle = normalizeRadians(pointerRadians - wheelStartRadians);

    const sectorIndex = Math.floor(localAngle / sectorAngle);

    return Math.min(Math.max(sectorIndex, 0), sectorCount - 1);

}

export function buildWinnerConfiguration(wheelConfiguration, players = []) {

    if (!wheelConfiguration?.sectors?.length) {

        throw new Error("Wheel configuration must include sectors");

    }

    const sectors = wheelConfiguration.sectors.map((sector, index) => ({
        index,
        color: sector.color,
        icon: sector.icon,
        playerId: sector.playerId ?? resolvePlayerIdForSector(
            sector,
            players,
            index
        )
    }));

    return {
        sectors,
        players: players.map((player) => ({
            id: player.id,
            nickname: player.nickname,
            icon: player.icon
        }))
    };

}

function resolvePlayerIdForSector(sector, players, sectorIndex) {

    const iconMatch = players.find((player) => player.icon === sector.icon);

    if (iconMatch) {

        return iconMatch.id;

    }

    const orderedPlayer = players[sectorIndex];

    return orderedPlayer?.id ?? null;

}

export function buildWinningSector(sector, sectorIndex) {

    return {
        index: sectorIndex,
        color: sector.color,
        icon: sector.icon,
        playerId: sector.playerId ?? null
    };

}

export function buildWinnerPlayer(player, winningSector) {

    if (!player) {

        return null;

    }

    return {
        id: player.id,
        nickname: player.nickname,
        icon: player.icon,
        color: winningSector.color
    };

}

export function resolveLocalOutcome(winnerId, localPlayerId) {

    if (winnerId === null || winnerId === undefined) {

        return null;

    }

    return winnerId === localPlayerId
        ? "WIN"
        : "LOSE";

}
