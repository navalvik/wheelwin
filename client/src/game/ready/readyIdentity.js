/**
 * Resolve the player bound to the actual PlayerIdentityProvider contract.
 * usePlayerIdentity() returns { identity, setIdentity, clearIdentity, getIdentity },
 * NOT a flat { playerId } object.
 */
export function resolveReadyPlayerId(identityContext) {
    const id = identityContext?.identity?.playerId;
    return typeof id === "string" && id.length > 0 ? id : null;
}

export function isLocalPlayerReady(readyPlayers, playerId) {
    return playerId !== null && playerId !== undefined
        && readyPlayers?.[playerId] === true;
}
