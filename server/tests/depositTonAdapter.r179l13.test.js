/**
 * R17.9L.13 — Real TON DepositMonitor adapter tests (mocked TON RPC only).
 * No live deploy, no sendBoc, no mnemonic, no TonConnect.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { beginCell, Cell, TupleBuilder, TupleReader } from "@ton/core";

import { DepositMonitor } from "../deposit/DepositMonitor.js";
import { DepositSessionCoordinator } from "../deposit/DepositSessionCoordinator.js";
import { TonFinancialDepositPersistence } from "../deposit/DepositPersistencePort.js";
import { TonFinancialDepositObservationPersistence } from "../deposit/DepositObservationPersistencePort.js";
import {
    DEPOSIT_ACCOUNT_STATE,
    DEPOSIT_ONCHAIN_STATUS,
    FUND_SEAT_OPCODE,
    RealTonDepositBlockchainSource,
    decodeFundSeatBody,
    encodeFundSeatBody
} from "../deposit/RealTonDepositBlockchainSource.js";
import { DEPOSIT_OBSERVATION_STATUS } from "../deposit/DepositObservationStates.js";
import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { GAME_ESCROW_ARTIFACT_BOC_PATH } from "../payment/ton/verifyGameEscrowArtifact.js";
import { DEPOSIT_CONTRACT_ARTIFACT_BOC_PATH } from "../payment/ton/verifyDepositArtifact.js";
import {
    InvalidResponseError,
    NetworkUnavailableError
} from "../services/ton/TonServiceErrors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER_SOURCE = readFileSync(
    join(__dirname, "../deposit/RealTonDepositBlockchainSource.js"),
    "utf8"
);

const WALLET_0 = "EQAGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBsDe";
const WALLET_1 = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";
const WALLET_2 = "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi";
const WALLET_OTHER = "EQADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA8id";
const DEPOSIT_ADDRESS = "EQAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBMWg";

const STAKE_NANO = 1_000_000_000;
const FEE_NANO = 100_000_000;
const EXPECTED_NANO = STAKE_NANO + FEE_NANO;

const DEPOSIT_CODE_B64 = readFileSync(DEPOSIT_CONTRACT_ARTIFACT_BOC_PATH).toString("base64");
const ESCROW_CODE_B64 = readFileSync(GAME_ESCROW_ARTIFACT_BOC_PATH).toString("base64");

function createLogger() {

    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        decisionTrace() {}
    };

}

function intGetter(value) {

    const builder = new TupleBuilder();

    builder.writeNumber(BigInt(value));

    return {
        exit_code: 0,
        stack: new TupleReader(builder.build())
    };

}

function fundSeatTx({
    hash,
    lt,
    sender,
    destination = DEPOSIT_ADDRESS,
    valueNano = EXPECTED_NANO,
    seatIndex = 0,
    aborted = false,
    bounced = false,
    computeSuccess = true
}) {

    return {
        aborted,
        success: aborted ? false : computeSuccess,
        compute_ph: { success: computeSuccess, skipped: false },
        utime: 1_800_000_000,
        transaction_id: { hash, lt: String(lt) },
        in_msg: {
            source: sender,
            destination,
            value: String(valueNano),
            bounced,
            msg_data: {
                "@type": "msg.dataRaw",
                body: encodeFundSeatBody(seatIndex).toBoc().toString("base64")
            }
        }
    };

}

class StubTonService {

    constructor({
        network = "testnet",
        account = null,
        transactions = [],
        getters = {},
        fail = null
    } = {}) {

        this._network = network;
        this.account = account;
        this.transactions = transactions;
        this.getters = getters;
        this.fail = fail;
        this.calls = [];
        this.sentBocs = [];

    }

    getActiveNetwork() {

        return this._network;

    }

    async getAccount(address) {

        this.calls.push(["getAccount", address]);

        if (this.fail === "getAccount" || this.fail === "rpc") {

            throw new NetworkUnavailableError("TON RPC unavailable");

        }

        return this.account;

    }

    async getTransactions(address) {

        this.calls.push(["getTransactions", address]);

        if (this.fail === "getTransactions" || this.fail === "rpc") {

            throw new NetworkUnavailableError("TON RPC unavailable");

        }

        return this.transactions;

    }

    async runGetMethod(address, method) {

        this.calls.push(["runGetMethod", method]);

        if (this.fail === "runGetMethod" || this.fail === "rpc" || this.fail === method) {

            throw new InvalidResponseError(`getter ${method} failed`);

        }

        if (!(method in this.getters)) {

            throw new InvalidResponseError(`missing getter ${method}`);

        }

        return this.getters[method];

    }

}

function defaultGetters(overrides = {}) {

    return {
        get_version: intGetter(1),
        get_deposit_id: intGetter(0x11),
        get_room_id_hash: intGetter(0x22),
        get_game_id_hash: intGetter(0x33),
        get_paid_mask: intGetter(0),
        get_status: intGetter(DEPOSIT_ONCHAIN_STATUS.AWAITING_FUNDS),
        get_credited_amount0: intGetter(0),
        get_credited_amount1: intGetter(0),
        get_credited_amount2: intGetter(0),
        get_surplus_nano: intGetter(0),
        get_expires_at: intGetter(1_800_000_000),
        get_network_tag: intGetter(0),
        ...overrides
    };

}

function activeAccount(codeB64 = DEPOSIT_CODE_B64, balance = "0") {

    return {
        state: "active",
        code: codeB64,
        data: beginCell().endCell().toBoc().toString("base64"),
        balance
    };

}

function threePlayers() {

    return [
        { playerId: "seat0", wallet: WALLET_0, expectedAmount: EXPECTED_NANO },
        { playerId: "seat1", wallet: WALLET_1, expectedAmount: EXPECTED_NANO },
        { playerId: "seat2", wallet: WALLET_2, expectedAmount: EXPECTED_NANO }
    ];

}

function createEventBus(logger) {

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    return eventBus;

}

function collectEvents(eventBus, types) {

    const emitted = [];

    for (const type of types) {

        eventBus.subscribe(type, (envelope) => {

            emitted.push({
                type,
                source: envelope.source,
                payload: envelope.payload
            });

        });

    }

    return emitted;

}

function createHarness({
    tonService,
    persistence = null,
    network = "testnet"
} = {}) {

    const logger = createLogger();
    const eventBus = createEventBus(logger);

    const depositPersistence = persistence
        ? new TonFinancialDepositPersistence(persistence)
        : null;

    const observationPersistence = persistence
        ? new TonFinancialDepositObservationPersistence(persistence)
        : null;

    const depositSessionCoordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: depositPersistence
    });

    const source = new RealTonDepositBlockchainSource({
        logger,
        tonService,
        network
    });

    const monitor = new DepositMonitor({
        logger,
        eventBus,
        depositSessionCoordinator,
        persistence: observationPersistence,
        blockchainSource: source,
        network
    });

    monitor.initialize();

    return {
        logger,
        eventBus,
        depositSessionCoordinator,
        monitor,
        source,
        persistence,
        depositPersistence
    };

}

function createWatchableSession(coordinator, {
    roomId = "room-a",
    gameId = "game-a",
    depositAddress = DEPOSIT_ADDRESS,
    players = threePlayers(),
    depositPersistence = null
} = {}) {

    const session = coordinator.createSession({ roomId, gameId });

    coordinator.bindPlayers(session.depositId, players);

    coordinator.markAwaitingFunds(session.depositId);

    coordinator.setDepositAddress(session.depositId, depositAddress); // R17.9L.21
    session.metadata = { network: "testnet" };

    if (depositPersistence) {

        depositPersistence.saveDepositSession(session);

    }

    return session;

}

function createDiskPersistence() {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-dton-l13-"));

    const persistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    persistence.initialize();

    return { dataDir, persistence };

}

function reopenPersistence(dataDir) {

    const persistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    persistence.initialize();

    return persistence;

}

test("R17.9L.13 Test1: DepositMonitor works with real adapter interface", async () => {

    const tonService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters(),
        transactions: [
            fundSeatTx({ hash: "tx-1", lt: 1, sender: WALLET_0, seatIndex: 0 })
        ]
    });

    const { monitor, source, depositSessionCoordinator, eventBus } = createHarness({
        tonService
    });

    const emitted = collectEvents(eventBus, [
        EVENT_TYPES.DEPOSIT_SEAT_FUNDED,
        EVENT_TYPES.DEPOSIT_FULL_ONCHAIN
    ]);

    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const result = await monitor.poll();

    assert.equal(result.observed, 1);
    assert.equal(result.results[0].ok, true);
    assert.ok(emitted.some((entry) => entry.type === EVENT_TYPES.DEPOSIT_SEAT_FUNDED));
    assert.equal(
        emitted.filter((entry) => entry.type === EVENT_TYPES.DEPOSIT_FULL_ONCHAIN).length,
        0
    );

});

test("R17.9L.13 Test2: nonexistent contract rejected", async () => {

    const tonService = new StubTonService({
        account: { state: "nonexist", balance: "0" },
        getters: defaultGetters(),
        transactions: [
            fundSeatTx({ hash: "tx-ghost", lt: 1, sender: WALLET_0 })
        ]
    });

    const { monitor, depositSessionCoordinator } = createHarness({ tonService });
    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const result = await monitor.poll();

    assert.equal(result.observed, 0);
    assert.equal(result.results[0].reason, "nonexistent_contract");
    assert.equal(result.results[0].contractState.state, DEPOSIT_ACCOUNT_STATE.NONEXISTENT);

});

test("R17.9L.13 Test3: uninitialized contract rejected", async () => {

    const tonService = new StubTonService({
        account: { state: "uninitialized", code: "", balance: "0" },
        getters: defaultGetters(),
        transactions: [
            fundSeatTx({ hash: "tx-uninit", lt: 1, sender: WALLET_0 })
        ]
    });

    const { monitor, depositSessionCoordinator } = createHarness({ tonService });
    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const result = await monitor.poll();

    assert.equal(result.observed, 0);
    assert.equal(result.results[0].reason, "uninitialized_contract");
    assert.equal(result.results[0].contractState.state, DEPOSIT_ACCOUNT_STATE.UNINIT);

});

test("R17.9L.13 Test4: wrong code hash rejected", async () => {

    const tonService = new StubTonService({
        account: activeAccount(ESCROW_CODE_B64),
        getters: defaultGetters(),
        transactions: [
            fundSeatTx({ hash: "tx-wrong-code", lt: 1, sender: WALLET_0 })
        ]
    });

    const { monitor, depositSessionCoordinator } = createHarness({ tonService });
    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const result = await monitor.poll();

    assert.equal(result.observed, 0);
    assert.equal(result.results[0].reason, "code_hash_mismatch");

});

test("R17.9L.13 Test5: correct code hash accepted", async () => {

    const tonService = new StubTonService({
        account: activeAccount(DEPOSIT_CODE_B64),
        getters: defaultGetters(),
        transactions: []
    });

    const { monitor, source, depositSessionCoordinator } = createHarness({ tonService });
    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const result = await monitor.poll();

    assert.equal(result.results[0].ok, true);
    assert.equal(result.results[0].reason, null);

    const state = await source.getContractState(DEPOSIT_ADDRESS);

    assert.equal(state.state, DEPOSIT_ACCOUNT_STATE.ACTIVE);
    assert.equal(
        state.codeHash,
        Cell.fromBoc(readFileSync(DEPOSIT_CONTRACT_ARTIFACT_BOC_PATH))[0].hash().toString("hex")
    );

});

test("R17.9L.13 Test6: wrong networkTag rejected", async () => {

    const tonService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters({
            get_network_tag: intGetter(1)
        }),
        transactions: [
            fundSeatTx({ hash: "tx-net", lt: 1, sender: WALLET_0 })
        ]
    });

    const { monitor, depositSessionCoordinator } = createHarness({
        tonService,
        network: "testnet"
    });

    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const result = await monitor.poll();

    assert.equal(result.observed, 0);
    assert.equal(result.results[0].reason, "network_tag_mismatch");

});

test("R17.9L.13 Test7: getter failure fails closed", async () => {

    const tonService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters(),
        fail: "get_status",
        transactions: [
            fundSeatTx({ hash: "tx-getter", lt: 1, sender: WALLET_0 })
        ]
    });

    const { monitor, depositSessionCoordinator } = createHarness({ tonService });
    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const result = await monitor.poll();

    assert.equal(result.observed, 0);
    assert.ok(["invalid_response", "rpc_unavailable"].includes(result.results[0].reason));

});

test("R17.9L.13 Test8: RPC failure produces no financial observation", async () => {

    const tonService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters(),
        fail: "rpc",
        transactions: [
            fundSeatTx({ hash: "tx-rpc", lt: 1, sender: WALLET_0 })
        ]
    });

    const { monitor, depositSessionCoordinator, eventBus } = createHarness({ tonService });

    const emitted = collectEvents(eventBus, [
        EVENT_TYPES.DEPOSIT_SEAT_FUNDED,
        EVENT_TYPES.DEPOSIT_FULL_ONCHAIN,
        EVENT_TYPES.DEPOSIT_OBSERVATION_RECEIVED
    ]);

    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const result = await monitor.poll();

    assert.equal(result.observed, 0);
    assert.equal(result.results[0].reason, "rpc_unavailable");
    assert.equal(emitted.length, 0);

});

test("R17.9L.13 Test9: successful FundSeat transaction decoded", async () => {

    const tonService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters(),
        transactions: [
            fundSeatTx({
                hash: "tx-fund",
                lt: 9,
                sender: WALLET_0,
                seatIndex: 0,
                valueNano: EXPECTED_NANO
            })
        ]
    });

    const { monitor, depositSessionCoordinator } = createHarness({ tonService });
    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const result = await monitor.poll();
    const observation = result.results[0].observations[0];

    assert.equal(observation.transactionHash, "tx-fund");
    assert.equal(observation.senderWallet, WALLET_0);
    assert.equal(observation.amount, EXPECTED_NANO);
    assert.equal(observation.seatIndex, 0);
    assert.equal(observation.observationStatus, DEPOSIT_OBSERVATION_STATUS.VALIDATED);

    const decoded = decodeFundSeatBody(encodeFundSeatBody(0));

    assert.equal(decoded.opcode, FUND_SEAT_OPCODE);
    assert.equal(decoded.seatIndex, 0);

});

test("R17.9L.13 Test10: wrong sender exposed correctly", async () => {

    const tonService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters(),
        transactions: [
            fundSeatTx({
                hash: "tx-wrong-sender",
                lt: 10,
                sender: WALLET_OTHER,
                seatIndex: 0
            })
        ]
    });

    const { monitor, depositSessionCoordinator } = createHarness({ tonService });
    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const result = await monitor.poll();
    const observation = result.results[0].observations[0];

    assert.equal(observation.senderWallet, WALLET_OTHER);
    assert.equal(observation.observationStatus, DEPOSIT_OBSERVATION_STATUS.REJECTED);

});

test("R17.9L.13 Test11: wrong seat index exposed correctly", async () => {

    const tonService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters(),
        transactions: [
            fundSeatTx({
                hash: "tx-wrong-seat",
                lt: 11,
                sender: WALLET_0,
                seatIndex: 2
            })
        ]
    });

    const { monitor, depositSessionCoordinator } = createHarness({ tonService });
    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const result = await monitor.poll();

    assert.equal(result.results[0].observations[0].seatIndex, 2);
    assert.equal(result.results[0].observations[0].senderWallet, WALLET_0);

});

test("R17.9L.13 Test12: partial funding transaction preserved", async () => {

    const tonService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters(),
        transactions: [
            fundSeatTx({
                hash: "tx-part-1",
                lt: 12,
                sender: WALLET_0,
                valueNano: 400_000_000,
                seatIndex: 0
            }),
            fundSeatTx({
                hash: "tx-part-2",
                lt: 13,
                sender: WALLET_0,
                valueNano: 600_000_000,
                seatIndex: 0
            })
        ]
    });

    const { monitor, depositSessionCoordinator } = createHarness({ tonService });
    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const result = await monitor.poll();
    const amounts = result.results[0].observations.map((item) => item.amount);

    assert.deepEqual(amounts, [400_000_000, 600_000_000]);
    assert.equal(result.results[0].observations.length, 2);

});

test("R17.9L.13 Test13: duplicate transaction is idempotent", async () => {

    const txs = [
        fundSeatTx({ hash: "tx-dup", lt: 14, sender: WALLET_0, seatIndex: 0 })
    ];

    const tonService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters(),
        transactions: txs
    });

    const { monitor, depositSessionCoordinator, eventBus } = createHarness({ tonService });

    const emitted = collectEvents(eventBus, [EVENT_TYPES.DEPOSIT_SEAT_FUNDED]);
    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    await monitor.poll();
    await monitor.poll();

    assert.equal(
        emitted.filter((entry) => entry.type === EVENT_TYPES.DEPOSIT_SEAT_FUNDED).length,
        1
    );

});

test("R17.9L.13 Test14: bounce/failure transaction rejected", async () => {

    const tonService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters(),
        transactions: [
            fundSeatTx({
                hash: "tx-bounce",
                lt: 15,
                sender: WALLET_0,
                aborted: true,
                bounced: true,
                computeSuccess: false
            })
        ]
    });

    const { monitor, depositSessionCoordinator } = createHarness({ tonService });
    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const result = await monitor.poll();

    assert.equal(result.observed, 0);
    assert.equal(result.results[0].skipped[0].reason, "failed_or_bounced");

});

test("R17.9L.13 Test15: overpayment value preserved exactly", async () => {

    const overpay = EXPECTED_NANO + 250_000_000;

    const tonService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters(),
        transactions: [
            fundSeatTx({
                hash: "tx-over",
                lt: 16,
                sender: WALLET_0,
                valueNano: overpay,
                seatIndex: 0
            })
        ]
    });

    const { monitor, depositSessionCoordinator } = createHarness({ tonService });
    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const result = await monitor.poll();

    assert.equal(result.results[0].observations[0].amount, overpay);
    assert.equal(Number.isInteger(result.results[0].observations[0].amount), true);

});

test("R17.9L.13 Test16: three funding txs do not emit DEPOSIT_FULL from adapter", async () => {

    const tonService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters({
            get_paid_mask: intGetter(7),
            get_status: intGetter(DEPOSIT_ONCHAIN_STATUS.FULL)
        }),
        transactions: [
            fundSeatTx({ hash: "tx-a", lt: 17, sender: WALLET_0, seatIndex: 0 }),
            fundSeatTx({ hash: "tx-b", lt: 18, sender: WALLET_1, seatIndex: 1 }),
            fundSeatTx({ hash: "tx-c", lt: 19, sender: WALLET_2, seatIndex: 2 })
        ]
    });

    const { monitor, source, depositSessionCoordinator, eventBus } = createHarness({
        tonService
    });

    const emitted = collectEvents(eventBus, [EVENT_TYPES.DEPOSIT_FULL_ONCHAIN]);
    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const result = await monitor.poll();

    assert.equal(result.observed, 3);
    assert.equal(source._eventBus, undefined);
    assert.ok(
        emitted.every((entry) => entry.source === EVENT_SOURCES.DEPOSIT_MONITOR)
    );

});

test("R17.9L.13 Test17: getter FULL only when paidMask is 0b111", async () => {

    const fullService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters({
            get_paid_mask: intGetter(7),
            get_status: intGetter(DEPOSIT_ONCHAIN_STATUS.FULL)
        })
    });

    const partialService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters({
            get_paid_mask: intGetter(3),
            get_status: intGetter(DEPOSIT_ONCHAIN_STATUS.PARTIALLY_FUNDED)
        })
    });

    const fullSource = new RealTonDepositBlockchainSource({
        logger: createLogger(),
        tonService: fullService,
        network: "testnet"
    });

    const partialSource = new RealTonDepositBlockchainSource({
        logger: createLogger(),
        tonService: partialService,
        network: "testnet"
    });

    const fullState = await fullSource.getDepositState(DEPOSIT_ADDRESS);
    const partialState = await partialSource.getDepositState(DEPOSIT_ADDRESS);

    assert.equal(Number(fullState.paidMask), 7);
    assert.equal(Number(fullState.status), DEPOSIT_ONCHAIN_STATUS.FULL);
    assert.equal(Number(partialState.paidMask), 3);
    assert.notEqual(Number(partialState.status), DEPOSIT_ONCHAIN_STATUS.FULL);

});

test("R17.9L.13 Test18: cross-room binding preserved for later rejection", async () => {

    const tonService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters({
            get_room_id_hash: intGetter(0xaaa)
        }),
        transactions: [
            fundSeatTx({ hash: "tx-room", lt: 20, sender: WALLET_0 })
        ]
    });

    const { monitor, depositSessionCoordinator } = createHarness({ tonService });
    const session = createWatchableSession(depositSessionCoordinator, {
        roomId: "room-a"
    });

    monitor.startWatching(session);

    const result = await monitor.poll();

    assert.equal(result.results[0].depositState.roomIdHash, 0xaaan);
    assert.equal(result.results[0].observations[0].depositId, session.depositId);

});

test("R17.9L.13 Test19: cross-game binding preserved for later rejection", async () => {

    const tonService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters({
            get_game_id_hash: intGetter(0xbbb)
        }),
        transactions: [
            fundSeatTx({ hash: "tx-game", lt: 21, sender: WALLET_0 })
        ]
    });

    const { monitor, depositSessionCoordinator } = createHarness({ tonService });
    const session = createWatchableSession(depositSessionCoordinator, {
        gameId: "game-a"
    });

    monitor.startWatching(session);

    const result = await monitor.poll();

    assert.equal(result.results[0].depositState.gameIdHash, 0xbbbn);
    assert.equal(result.results[0].observations[0].depositId, session.depositId);

});

test("R17.9L.13 Test20: restart restores watch and does not duplicate", async () => {

    const txs = [
        fundSeatTx({ hash: "tx-restart", lt: 22, sender: WALLET_0, seatIndex: 0 })
    ];

    const { dataDir, persistence } = createDiskPersistence();

    const firstService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters(),
        transactions: txs
    });

    const first = createHarness({ tonService: firstService, persistence });
    const session = createWatchableSession(first.depositSessionCoordinator, {
        depositPersistence: first.depositPersistence
    });

    first.monitor.startWatching(session);
    await first.monitor.poll();

    const secondPersistence = reopenPersistence(dataDir);
    const secondService = new StubTonService({
        account: activeAccount(),
        getters: defaultGetters(),
        transactions: txs
    });

    const second = createHarness({
        tonService: secondService,
        persistence: secondPersistence
    });

    second.depositSessionCoordinator.restoreFromPersistence(session.depositId);

    const restoredSession = second.depositSessionCoordinator.getSession(session.depositId);

    second.depositSessionCoordinator.setDepositAddress(restoredSession.depositId, DEPOSIT_ADDRESS); // R17.9L.21 idempotent
    restoredSession.metadata = { network: "testnet" };

    if (restoredSession.state === DEPOSIT_SESSION_STATUS.CREATED) {

        second.depositSessionCoordinator.markAwaitingFunds(session.depositId);

    }

    const restored = second.monitor.restoreActiveWatches();

    assert.ok(restored.restored >= 1);

    const emitted = collectEvents(second.eventBus, [EVENT_TYPES.DEPOSIT_SEAT_FUNDED]);

    await second.monitor.poll();

    assert.equal(emitted.length, 0);

});

test("R17.9L.13 security: fake address/hash/sender/amount/balance/rpc/code/network/dup/no-send", async () => {

    const balanceOnly = new StubTonService({
        account: activeAccount(DEPOSIT_CODE_B64, String(EXPECTED_NANO * 10)),
        getters: defaultGetters(),
        transactions: []
    });

    const { monitor, depositSessionCoordinator, eventBus } = createHarness({
        tonService: balanceOnly
    });

    const emitted = collectEvents(eventBus, [
        EVENT_TYPES.DEPOSIT_SEAT_FUNDED,
        EVENT_TYPES.DEPOSIT_FULL_ONCHAIN
    ]);

    const session = createWatchableSession(depositSessionCoordinator);

    monitor.startWatching(session);

    const balanceResult = await monitor.poll();

    assert.equal(balanceResult.observed, 0);
    assert.equal(emitted.length, 0);

    assert.match(ADAPTER_SOURCE, /verifyDepositArtifact|loadDepositCodeCell/);
    assert.doesNotMatch(ADAPTER_SOURCE, /\.sendBoc\s*\(/);
    assert.doesNotMatch(ADAPTER_SOURCE, /mnemonic/i);
    assert.doesNotMatch(ADAPTER_SOURCE, /TON_DEPLOYER_MNEMONIC/);
    assert.doesNotMatch(ADAPTER_SOURCE, /broadcastTransaction/);
    assert.doesNotMatch(ADAPTER_SOURCE, /secretKey|privateKey/);
    assert.doesNotMatch(ADAPTER_SOURCE, /GameContractManager/);

    assert.ok(!("broadcastTransaction" in RealTonDepositBlockchainSource.prototype));
    assert.ok(!("sendBoc" in RealTonDepositBlockchainSource.prototype));

    const clientOverride = new RealTonDepositBlockchainSource({
        logger: createLogger(),
        tonService: new StubTonService({
            account: activeAccount(),
            getters: defaultGetters(),
            transactions: [
                fundSeatTx({
                    hash: "tx-chain-sender",
                    lt: 30,
                    sender: WALLET_1,
                    valueNano: EXPECTED_NANO,
                    seatIndex: 1
                })
            ]
        }),
        network: "testnet"
    });

    const decoded = clientOverride._decodeFundingTransaction(
        fundSeatTx({
            hash: "tx-chain-sender",
            lt: 30,
            sender: WALLET_1,
            valueNano: 7,
            seatIndex: 1
        }),
        { depositId: "dep_x", depositAddress: DEPOSIT_ADDRESS }
    );

    assert.equal(decoded.observation.senderWallet, WALLET_1);
    assert.equal(decoded.observation.amount, 7);
    assert.notEqual(decoded.observation.senderWallet, WALLET_0);

});
