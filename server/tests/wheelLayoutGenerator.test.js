import assert from "node:assert/strict";

import { GameCatalog } from "../catalog/GameCatalog.js";
import { LoggerService } from "../services/LoggerService.js";
import { RandomService } from "../services/RandomService.js";
import { resolvePlayerSetupColors } from "../engines/configuration/colorCatalog.js";
import {
    areCircleIndicesAdjacent,
    generateWheelLayout,
    validateWheelLayout
} from "../engines/configuration/wheelLayoutGenerator.js";

const logger = new LoggerService({ logLevel: "error" });

logger.initialize();

const catalog = new GameCatalog({ logger });

catalog.initialize();

const randomService = new RandomService({ logger });

randomService.initialize();

randomService.setSeed(4242);

function buildPlayer({
    playerId,
    sectorCount,
    arrangement = "together",
    colors
}) {

    const labels = colors ?? (sectorCount === 1
        ? ["Red"]
        : ["Green", "Blue"]);

    return {
        playerId,
        nickname: playerId,
        sectorCount,
        sectorArrangement: sectorCount === 2 ? arrangement : null,
        colors: resolvePlayerSetupColors(labels, catalog.getColors()),
        icon: "icon-a"
    };

}

function assertLayoutValid(players, sectors) {

    validateWheelLayout({
        sectors,
        players,
        minSectors: 3,
        maxSectors: 6
    });

    const expectedTotal = players.reduce(
        (sum, player) => sum + player.sectorCount,
        0
    );

    assert.equal(sectors.length, expectedTotal, "sector count must match purchases");

    const sectorIds = new Set(sectors.map((sector) => sector.sectorId));

    assert.equal(sectorIds.size, sectors.length, "sector IDs must be unique");

}

function generateForCounts(sectorCounts, arrangement = "together") {

    const players = sectorCounts.map((sectorCount, index) => buildPlayer({
        playerId: `player-${index + 1}`,
        sectorCount,
        arrangement: sectorCount === 2 ? arrangement : undefined,
        colors: sectorCount === 1
            ? [["Red", "Green", "Blue"][index]]
            : [
                ["Green", "Yellow"],
                ["Blue", "Orange"],
                ["Violet", "Beige"]
            ][index]
    }));

    const layout = generateWheelLayout({
        players,
        randomService
    });

    assertLayoutValid(players, layout.sectors);

    return { players, layout };

}

const threeSectorGame = generateForCounts([1, 1, 1]);

assert.equal(threeSectorGame.layout.sectors.length, 3, "1+1+1 must produce 3 sectors");

const fourSectorGame = generateForCounts([2, 1, 1]);

assert.equal(fourSectorGame.layout.sectors.length, 4, "2+1+1 must produce 4 sectors");

const fiveSectorGame = generateForCounts([2, 2, 1]);

assert.equal(fiveSectorGame.layout.sectors.length, 5, "2+2+1 must produce 5 sectors");

const sixSectorGame = generateForCounts([2, 2, 2]);

assert.equal(sixSectorGame.layout.sectors.length, 6, "2+2+2 must produce 6 sectors");

for (let attempt = 0; attempt < 20; attempt += 1) {

    const player = buildPlayer({
        playerId: "together-player",
        sectorCount: 2,
        arrangement: "together",
        colors: ["Red", "Blue"]
    });

    const layout = generateWheelLayout({
        players: [
            player,
            buildPlayer({ playerId: "p2", sectorCount: 1, colors: ["Green"] }),
            buildPlayer({ playerId: "p3", sectorCount: 1, colors: ["Yellow"] })
        ],
        randomService
    });

    const owned = layout.sectors
        .map((sector, index) => ({ sector, index }))
        .filter((entry) => entry.sector.ownerId === "together-player");

    assert.equal(owned.length, 2, "together player must own two sectors");

    assert.ok(
        areCircleIndicesAdjacent(owned[0].index, owned[1].index, layout.sectors.length),
        "TOGETHER must always produce adjacent sectors"
    );

}

for (let attempt = 0; attempt < 20; attempt += 1) {

    const player = buildPlayer({
        playerId: "separate-player",
        sectorCount: 2,
        arrangement: "separate",
        colors: ["Red", "Blue"]
    });

    const layout = generateWheelLayout({
        players: [
            player,
            buildPlayer({ playerId: "p2", sectorCount: 1, colors: ["Green"] }),
            buildPlayer({ playerId: "p3", sectorCount: 1, colors: ["Yellow"] })
        ],
        randomService
    });

    const owned = layout.sectors
        .map((sector, index) => ({ sector, index }))
        .filter((entry) => entry.sector.ownerId === "separate-player");

    assert.equal(owned.length, 2, "separate player must own two sectors");

    assert.ok(
        !areCircleIndicesAdjacent(owned[0].index, owned[1].index, layout.sectors.length),
        "SEPARATE must never produce adjacent sectors"
    );

}

const colorGame = generateForCounts([2, 2, 1], "separate");

for (const player of colorGame.players) {

    const owned = colorGame.layout.sectors
        .filter((sector) => sector.ownerId === player.playerId)
        .sort((left, right) => left.sectorIndexForPlayer - right.sectorIndexForPlayer);

    const expected = player.colors.map((color) => color.hex);
    const actual = owned.map((sector) => sector.color);

    assert.deepEqual(actual, expected, `${player.playerId} colors must match setup`);

}

for (const sector of sixSectorGame.layout.sectors) {

    assert.equal(typeof sector.angleStart, "number", "angleStart required");

    assert.equal(typeof sector.angleEnd, "number", "angleEnd required");

    assert.equal(sector.angleEnd - sector.angleStart, 60, "six-sector wheel uses 60° slices");

}

console.log("wheelLayoutGenerator.test.js passed");

randomService.shutdown();

logger.shutdown();
