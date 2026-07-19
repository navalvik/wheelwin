/**
 * C5.3 — Authoritative player view helpers.
 *
 * Maps AuthoritativeSession.players for UI without inventing player data.
 * Missing server fields render as empty/placeholder presentation values only.
 */

import { calculatePaymentGram } from "../../utils/playerProfileRules.js";

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

function resolveSectorCount(player) {

    if (Number(player?.sectorCount) === 2) {

        return 2;

    }

    if (Number(player?.sectorValue) === 2) {

        return 2;

    }

    return 1;

}

export function getAuthoritativePlayerSectorCount(player) {

    return resolveSectorCount(player);

}

/**
 * Maps one authoritative player record to Page3 PlayerInfoRow props.
 * Local identity is matched by authoritative playerId — never by array order.
 */
export function mapAuthoritativePlayerToInfoProp(
    player,
    index,
    {
        localPlayerId = null,
        baseStake = 0
    } = {}
) {

    const playerId = player.playerId ?? null;

    const isLocal = Boolean(
        localPlayerId
        && playerId
        && String(playerId) === String(localPlayerId)
    );

    // Redacted Verify-barrier rows have null sector fields — do not invent
    // sectorCount=1 / payment until the server reveals profiles.
    const profileRevealed = player.sectorCount != null
        || player.sectorValue != null
        || player.nickname != null;

    const sectorCount = profileRevealed
        ? resolveSectorCount(player)
        : null;

    const paymentGram = profileRevealed
        ? calculatePaymentGram(baseStake, sectorCount)
        : null;

    const ordinal = index + 1;

    return {
        key: playerId ?? `player-${index}`,
        playerId,
        isLocal,
        labelTitle: isLocal
            ? `PLAYER ${ordinal} — YOU`
            : (player.labelTitle ?? `PLAYER ${ordinal}`),
        nickname: player.nickname ?? MISSING,
        icon: player.icon ?? MISSING,
        age: player.age ?? MISSING,
        sectorLabel: player.sectorLabel ?? "SECTOR",
        sectorValue: player.sectorValue ?? MISSING,
        sectorCount,
        paymentGram,
        paymentLabel: "YOU NEED PAY",
        paymentDisplay: Number.isFinite(paymentGram) ? String(paymentGram) : MISSING,
        online: player.online
    };

}

export const mapAuthoritativePlayerToInfoRow = mapAuthoritativePlayerToInfoProp;
