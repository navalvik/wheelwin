export function resolveOpenPage5GameKey(payload, identity) {
    return payload?.gameId
        ?? identity?.gameId
        ?? identity?.roomId
        ?? null;
}

export function isDuplicateOpenPage5(lastOpenedGameKey, payload, identity) {
    const gameKey = resolveOpenPage5GameKey(payload, identity);
    return Boolean(gameKey && lastOpenedGameKey === gameKey);
}

export function resolveOpenPage5Authorization({
    payload,
    identity,
    currentPage,
    lastOpenedGameKey,
    authorizedGame
}) {
    if (!payload?.roomId || payload.roomId !== identity?.roomId) return null;

    const gameId = resolveOpenPage5GameKey(payload, identity);
    if (!gameId || isDuplicateOpenPage5(lastOpenedGameKey, payload, identity)) return null;

    const hasNewGameAuthorization = authorizedGame?.gameId === gameId
        && Boolean(authorizedGame.previousGameId)
        && authorizedGame.previousGameId !== gameId;
    if (currentPage === 8 && !hasNewGameAuthorization) return null;

    return {
        gameId,
        previousGameId: hasNewGameAuthorization
            ? authorizedGame.previousGameId
            : identity?.gameId ?? null,
        authoritativeNewGame: hasNewGameAuthorization
    };
}
