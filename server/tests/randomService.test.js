import { RandomService } from "../services/RandomService.js";
import { LoggerService } from "../services/LoggerService.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const logger = new LoggerService();

logger.initialize();

const randomService = new RandomService({ logger });

randomService.initialize();

const productionValue = randomService.nextFloat();

assert(
    productionValue >= 0 && productionValue < 1,
    "nextFloat should return a value in [0, 1)"
);

assert(
    randomService.nextInt(2, 5) >= 2 && randomService.nextInt(2, 5) <= 5,
    "nextInt should stay within inclusive bounds"
);

const source = ["a", "b", "c"];

const picked = randomService.pick(source);

assert(source.includes(picked), "pick should return an array element");

const shuffled = randomService.shuffle(source);

assert(
    source.join("") === "abc",
    "shuffle must not mutate the original array"
);

assert(
    shuffled.length === source.length,
    "shuffle should preserve array length"
);

randomService.setSeed(1458);

const deterministicSequence = [
    randomService.nextFloat(),
    randomService.nextFloat(),
    randomService.nextInt(1, 10),
    randomService.pick(["blue", "green", "red"])
];

randomService.setSeed(1458);

const repeatedSequence = [
    randomService.nextFloat(),
    randomService.nextFloat(),
    randomService.nextInt(1, 10),
    randomService.pick(["blue", "green", "red"])
];

assert(
    deterministicSequence.join("|") === repeatedSequence.join("|"),
    "deterministic mode should reproduce the same sequence"
);

randomService.clearSeed();

const afterClear = randomService.nextFloat();

randomService.setSeed(1458);

const afterReseed = randomService.nextFloat();

assert(
    afterReseed === repeatedSequence[0],
    "re-seeding should restore deterministic sequence"
);

assert(
    randomService.generateTraceSeed().startsWith("trace_seed_"),
    "generateTraceSeed should return a trace seed prefix"
);

let threwOnEmptyPick = false;

try {

    randomService.pick([]);

} catch {

    threwOnEmptyPick = true;

}

assert(threwOnEmptyPick, "pick should reject empty arrays");

randomService.shutdown();

logger.info("RandomService tests passed");
