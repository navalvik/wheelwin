/**
 * R5.12B — Server-authoritative wheel layout generation.
 *
 * Places each player's purchased sectors on a circular wheel while honoring
 * TOGETHER / SEPARATE arrangement rules. Player order is randomized.
 */

export function areCircleIndicesAdjacent(firstIndex, secondIndex, sectorCount) {

    if (firstIndex === secondIndex) {

        return true;

    }

    return (firstIndex + 1) % sectorCount === secondIndex
        || (secondIndex + 1) % sectorCount === firstIndex;

}

function findPlacementsForPlayer(player, slots, sectorCount) {

    const placements = [];

    if (player.sectorCount === 1) {

        for (let index = 0; index < sectorCount; index += 1) {

            if (slots[index] !== null) {

                continue;

            }

            placements.push([
                {
                    index,
                    color: player.colors[0],
                    sectorIndexForPlayer: 0
                }
            ]);

        }

        return placements;

    }

    const arrangement = player.sectorArrangement === "separate"
        ? "separate"
        : "together";

    if (arrangement === "together") {

        for (let index = 0; index < sectorCount; index += 1) {

            const nextIndex = (index + 1) % sectorCount;

            if (slots[index] !== null || slots[nextIndex] !== null) {

                continue;

            }

            placements.push([
                {
                    index,
                    color: player.colors[0],
                    sectorIndexForPlayer: 0
                },
                {
                    index: nextIndex,
                    color: player.colors[1],
                    sectorIndexForPlayer: 1
                }
            ]);

        }

        return placements;

    }

    for (let firstIndex = 0; firstIndex < sectorCount; firstIndex += 1) {

        for (let secondIndex = firstIndex + 1; secondIndex < sectorCount; secondIndex += 1) {

            if (areCircleIndicesAdjacent(firstIndex, secondIndex, sectorCount)) {

                continue;

            }

            if (slots[firstIndex] !== null || slots[secondIndex] !== null) {

                continue;

            }

            placements.push([
                {
                    index: firstIndex,
                    color: player.colors[0],
                    sectorIndexForPlayer: 0
                },
                {
                    index: secondIndex,
                    color: player.colors[1],
                    sectorIndexForPlayer: 1
                }
            ]);

        }

    }

    return placements;

}

function applyPlacement(slots, player, placement) {

    for (const entry of placement) {

        slots[entry.index] = {
            playerId: player.playerId,
            nickname: player.nickname ?? null,
            icon: player.icon,
            color: entry.color.hex,
            colorId: entry.color.id,
            sectorIndexForPlayer: entry.sectorIndexForPlayer
        };

    }

}

function clearPlacement(slots, placement) {

    for (const entry of placement) {

        slots[entry.index] = null;

    }

}

function placePlayers(players, playerIndex, slots, sectorCount, randomService) {

    if (playerIndex >= players.length) {

        return true;

    }

    const player = players[playerIndex];

    const placements = findPlacementsForPlayer(player, slots, sectorCount);

    if (placements.length === 0) {

        return false;

    }

    const shuffledPlacements = randomService.shuffle(placements);

    for (const placement of shuffledPlacements) {

        applyPlacement(slots, player, placement);

        if (placePlayers(
            players,
            playerIndex + 1,
            slots,
            sectorCount,
            randomService
        )) {

            return true;

        }

        clearPlacement(slots, placement);

    }

    return false;

}

function buildSectorsFromSlots(slots, sectorCount) {

    const sectorAngle = 360 / sectorCount;

    return slots.map((slot, index) => ({

        sectorId: `sector_${index}`,
        ownerId: slot.playerId,
        nickname: slot.nickname,
        color: slot.color,
        colorId: slot.colorId,
        icon: slot.icon,
        sectorIndexForPlayer: slot.sectorIndexForPlayer,
        angleStart: index * sectorAngle,
        angleEnd: (index + 1) * sectorAngle

    }));

}

export function generateWheelLayout({
    players,
    randomService,
    maxAttempts = 500
}) {

    const totalSectors = players.reduce(
        (sum, player) => sum + player.sectorCount,
        0
    );

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {

        const orderedPlayers = randomService.shuffle([...players]);

        const slots = Array(totalSectors).fill(null);

        if (placePlayers(orderedPlayers, 0, slots, totalSectors, randomService)) {

            return {
                sectors: buildSectorsFromSlots(slots, totalSectors),
                playerOrder: orderedPlayers.map((player) => player.playerId)
            };

        }

    }

    throw new Error(
        `Failed to generate valid wheel layout (${totalSectors} sectors)`
    );

}

export function validateWheelLayout({
    sectors,
    players,
    minSectors = 3,
    maxSectors = 6
}) {

    const totalSectors = sectors.length;

    if (totalSectors < minSectors || totalSectors > maxSectors) {

        throw new Error("Sector count is outside wheel limits");

    }

    const expectedTotal = players.reduce(
        (sum, player) => sum + player.sectorCount,
        0
    );

    if (totalSectors !== expectedTotal) {

        throw new Error("Sector count does not match player selections");

    }

    const sectorIds = new Set();

    const ownerCounts = new Map();

    const ownerSlots = new Map();

    for (const sector of sectors) {

        if (sectorIds.has(sector.sectorId)) {

            throw new Error(`Duplicate sectorId (${sector.sectorId})`);

        }

        sectorIds.add(sector.sectorId);

        if (!sector.ownerId) {

            throw new Error("Sector must have an owner");

        }

        ownerCounts.set(
            sector.ownerId,
            (ownerCounts.get(sector.ownerId) ?? 0) + 1
        );

        if (!ownerSlots.has(sector.ownerId)) {

            ownerSlots.set(sector.ownerId, []);

        }

        ownerSlots.get(sector.ownerId).push(sector);

    }

    for (const player of players) {

        const owned = ownerCounts.get(player.playerId) ?? 0;

        if (owned !== player.sectorCount) {

            throw new Error(
                `Player ${player.playerId} owns ${owned} sectors, expected ${player.sectorCount}`
            );

        }

        const playerSectors = (ownerSlots.get(player.playerId) ?? [])
            .sort((left, right) => left.sectorIndexForPlayer - right.sectorIndexForPlayer);

        const setupColors = player.colors.map((color) => color.hex);

        const assignedColors = playerSectors.map((sector) => sector.color);

        if (setupColors.length !== assignedColors.length
            || setupColors.some((color, index) => color !== assignedColors[index])) {

            throw new Error(
                `Player ${player.playerId} sector colors do not match PLAYER SETUP`
            );

        }

        if (player.sectorCount === 2) {

            const indices = playerSectors.map((sector) => sectors.indexOf(sector));

            const adjacent = areCircleIndicesAdjacent(
                indices[0],
                indices[1],
                totalSectors
            );

            const arrangement = player.sectorArrangement === "separate"
                ? "separate"
                : "together";

            if (arrangement === "together" && !adjacent) {

                throw new Error(
                    `Player ${player.playerId} TOGETHER sectors are not adjacent`
                );

            }

            if (arrangement === "separate" && adjacent) {

                throw new Error(
                    `Player ${player.playerId} SEPARATE sectors are adjacent`
                );

            }

        }

    }

    return true;

}
