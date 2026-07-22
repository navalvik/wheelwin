import { GameCatalog } from "../catalog/GameCatalog.js";
import { LoggerService } from "../services/LoggerService.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const logger = new LoggerService();

logger.initialize();

const catalog = new GameCatalog({ logger });

catalog.initialize();

assert(catalog.getCatalogVersion() === "1.0", "catalog version should be 1.0");

assert(catalog.getColors().length === 10, "catalog should expose 10 colors");

assert(catalog.getIcons().length === 24, "catalog should expose 24 icons");

assert(catalog.getStakes().length === 2, "catalog should expose 2 stakes");

assert(catalog.getWheelRules().minSectors === 3, "wheel min sectors should be 3");

assert(catalog.getTimers().READY.durationMs === 3000, "ready timer should be defined");

const colors = catalog.getColors();

try {

    colors.push({ id: "INVALID", hex: "#000000" });

    throw new Error("catalog colors should be immutable");

} catch (error) {

    assert(error instanceof TypeError, "mutating colors should throw");

}

logger.info("GameCatalog tests passed");
