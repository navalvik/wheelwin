/**
 * R5.15 / R5.17 — Authoritative player profile completeness.
 *
 * Page2 fields are complete without an icon.
 * VERIFY assigns the immutable icon; full completeness requires icon for
 * ConfigurationEngine.
 */

export function isPage2ProfileComplete(identity) {

    if (!identity?.playerId) {

        return false;

    }

    if (typeof identity.nickname !== "string" || !identity.nickname.trim()) {

        return false;

    }

    if (identity.sectorCount !== 1 && identity.sectorCount !== 2) {

        return false;

    }

    if (typeof identity.color !== "string" || !identity.color.trim()) {

        return false;

    }

    if (identity.sectorCount === 2) {

        if (typeof identity.colorSector2 !== "string"
            || !identity.colorSector2.trim()) {

            return false;

        }

    }

    return true;

}

export function isPlayerProfileComplete(identity) {

    if (!isPage2ProfileComplete(identity)) {

        return false;

    }

    if (typeof identity.icon !== "string" || !identity.icon.trim()) {

        return false;

    }

    return true;

}

export function areRoomPage2ProfilesComplete(playerManager, playerIds) {

    if (!playerManager || !Array.isArray(playerIds) || playerIds.length === 0) {

        return false;

    }

    return playerIds.every((playerId) => isPage2ProfileComplete(
        playerManager.getIdentity(playerId)
    ));

}

export function areRoomPlayerProfilesComplete(playerManager, playerIds) {

    if (!playerManager || !Array.isArray(playerIds) || playerIds.length === 0) {

        return false;

    }

    return playerIds.every((playerId) => isPlayerProfileComplete(
        playerManager.getIdentity(playerId)
    ));

}
