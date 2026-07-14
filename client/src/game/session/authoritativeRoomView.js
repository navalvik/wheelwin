/**
 * C5.4 — Authoritative room metadata view helpers.
 *
 * Reads room fields already mirrored on AuthoritativeSession (roomId,
 * maxPlayers, players). Never invents room identifiers or capacity.
 */

import {
    formatAuthoritativePlayerCount,
    listAuthoritativePlayers
} from "./authoritativePlayerView.js";

/**
 * Passive room view derived from the authoritative session mirror.
 * Fields stay null until a server event has supplied them.
 */
export function getAuthoritativeRoom(session = {}) {

    const players = session.players ?? {};

    return {
        roomId: session.roomId ?? null,
        maxPlayers: session.maxPlayers ?? null,
        connectedCount: listAuthoritativePlayers(players).length,
        status: session.roomStatus ?? null
    };

}

/**
 * Returns null when no authoritative roomId has arrived so the UI can show a
 * placeholder instead of a mock identifier such as "8F4K2S".
 */
export function formatAuthoritativeRoomId(roomId) {

    if (roomId === null || roomId === undefined || roomId === "") {

        return null;

    }

    return String(roomId);

}

/**
 * Resolves maxPlayers preference: authoritative first, otherwise the existing
 * non-authoritative fallback (GameSession). Never invents a new capacity.
 */
export function resolveRoomMaxPlayers(authoritativeMaxPlayers, fallbackMaxPlayers) {

    if (authoritativeMaxPlayers !== null
        && authoritativeMaxPlayers !== undefined) {

        return authoritativeMaxPlayers;

    }

    return fallbackMaxPlayers;

}

/**
 * Formats the InfoBar PLAYERS cell from authoritative players + resolved max.
 * Returns null when no authoritative players have arrived.
 */
export function formatAuthoritativeRoomPlayersDisplay(
    playersById,
    authoritativeMaxPlayers,
    fallbackMaxPlayers
) {

    return formatAuthoritativePlayerCount(
        playersById,
        resolveRoomMaxPlayers(authoritativeMaxPlayers, fallbackMaxPlayers)
    );

}
