/**
 * C5.3 — Authoritative player view helpers.
 *
 * Maps AuthoritativeSession.players for UI without inventing player data.
 * Missing server fields render as empty/placeholder presentation values only.
 */

const MISSING = "—";

export function listAuthoritativePlayers(playersById = {}) {

    return Object.values(playersById)
        .filter(Boolean)
        .sort((left, right) => String(left.playerId)
            .localeCompare(String(right.playerId)));

}

export function hasAuthoritativePlayers(playersById = {}) {

    return listAuthoritativePlayers(playersById).length > 0;

}

/**
 * Returns null when no authoritative players have arrived so the UI can show
 * a loading/empty placeholder instead of a fake count.
 */
export function formatAuthoritativePlayerCount(playersById, maxPlayers) {

    const count = listAuthoritativePlayers(playersById).length;

    if (count === 0) {

        return null;

    }

    if (maxPlayers === null || maxPlayers === undefined) {

        return String(count);

    }

    return `${count} / ${maxPlayers}`;

}

/**
 * Maps one authoritative player record to Page3 PlayerInfoRow props.
 * Never pulls DEV_VERIFY_PLAYERS / GameSession mock fields.
 */
export function mapAuthoritativePlayerToInfoRow(player, index) {

    return {
        key: player.playerId ?? `player-${index}`,
        labelTitle: player.labelTitle ?? `PLAYER ${index + 1}`,
        nickname: player.nickname ?? MISSING,
        icon: player.icon ?? MISSING,
        age: player.age ?? MISSING,
        sectorLabel: player.sectorLabel ?? "SECTOR",
        sectorValue: player.sectorValue ?? MISSING,
        online: player.online
    };

}
