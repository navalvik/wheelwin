export function createConfigurationPlayer({
    playerId,
    sectorCount = 2,
    sectorArrangement = "together",
    colors = null,
    nickname = null
}) {

    const palette = [
        ["Red"],
        ["Green", "Blue"],
        ["Yellow", "Orange"]
    ];

    const resolvedColors = colors
        ?? (sectorCount === 1
            ? palette[0]
            : palette[1]);

    return {
        playerId,
        nickname: nickname ?? playerId,
        sectorCount,
        sectorArrangement: sectorCount === 2 ? sectorArrangement : undefined,
        colors: resolvedColors
    };

}

export function createStandardConfigurationPlayers(playerIds) {

    const twoSectorColors = [
        ["Red", "Blue"],
        ["Green", "Yellow"],
        ["Orange", "Violet"]
    ];

    return playerIds.map((playerId, index) => createConfigurationPlayer({
        playerId,
        sectorCount: 2,
        colors: twoSectorColors[index] ?? ["Red", "Blue"]
    }));

}
