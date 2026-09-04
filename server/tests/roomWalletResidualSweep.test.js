/**
 * Room Wallet residual sweep — policy, destination, mapping, lifecycle.
 * Mocked TON only. No funding, no Residues Wallet creation, no chain sends.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    DuplicateRecordError,
    TonFinancialPersistence,
    TON_FINANCIAL_RECORD_TYPES
} from "../persistence/TonFinancialPersistence.js";
import { ROOM_LEDGER_ENTRY_TYPES } from "../payment/roomWallet/RoomWalletLedger.js";
import { ROOM_WALLET_POLICY } from "../payment/roomWallet/RoomWalletFinancialPolicy.js";
import { RoomWalletRegistry } from "../payment/roomWallet/RoomWalletRegistry.js";
import { RoomWalletResidualSweepRepository } from "../payment/roomWallet/RoomWalletResidualSweepRepository.js";
import { RoomWalletResidualSweepWorker } from "../payment/roomWallet/RoomWalletResidualSweepWorker.js";
import { RESIDUAL_SWEEP_STATUS } from "../payment/roomWallet/residualSweepStates.js";
import {
    isRoomWalletPaymentIntakeEnabled,
    isRoomWalletResidualSweepEnabled,
    resolveResiduesWalletDestination
} from "../payment/roomWallet/roomWalletConfig.js";
import { createDummyRoomWalletEntry } from "./helpers/dummyRoomWallet.js";

const SOURCE = createDummyRoomWalletEntry(1);
const OTHER_ROOM = createDummyRoomWalletEntry(2);
const RESIDUES_ADDRESS = OTHER_ROOM.address;

function createLogger() {
    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        startupLine() {}
    };
}

function createEventBus() {
    const eventBus = new EventBus({
        logger: createLogger(),
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();
    return eventBus;
}

function createPersistence() {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-residual-sweep-"));
    const persistence = new TonFinancialPersistence({
        dataDir,
        logger: createLogger(),
        autoCheckpoint: false
    });
    persistence.initialize();
    return { dataDir, persistence };
}

function createHarness({
    enabled = true,
    residuesAddress = RESIDUES_ADDRESS,
    balanceNano = 500_000_000n,
    sendImpl = null,
    watchImpl = null
} = {}) {
    const { dataDir, persistence } = createPersistence();
    const registry = new RoomWalletRegistry({
        entries: [
            { roomNumber: 1, address: SOURCE.address, network: "testnet" },
            { roomNumber: 2, address: OTHER_ROOM.address, network: "testnet" }
        ]
    });
    const sends = [];
    const watches = [];
    const balances = new Map([[1, balanceNano], [2, 0n]]);
    const adapter = {
        async getBalance(roomNumber) {
            return balances.get(Number(roomNumber)) ?? 0n;
        },
        async sendTransfer(input) {
            sends.push(input);
            if (typeof sendImpl === "function") {
                return sendImpl(input, sends);
            }
            return {
                ok: true,
                code: "SENT",
                roomNumber: input.roomNumber,
                address: SOURCE.address,
                destination: input.destination,
                amountNano: input.amountNano,
                gasReserveNano: input.sourceReserveNano,
                seqno: 1,
                txHash: "sweep_tx_hash_1"
            };
        }
    };
    const blockchainMonitor = {
        watchTransaction(input) {
            watches.push(input);
            if (typeof watchImpl === "function") {
                return watchImpl(input);
            }
            return { status: "PENDING", ...input };
        }
    };
    const eventBus = createEventBus();
    const env = {
        ROOM_WALLET_RESIDUAL_SWEEP_ENABLED: enabled ? "true" : "",
        TON_RESIDUES_EXPECTED_ADDRESS: residuesAddress
    };
    const repository = new RoomWalletResidualSweepRepository({
        persistence,
        tonNetwork: "testnet"
    });
    const worker = new RoomWalletResidualSweepWorker({
        repository,
        roomWalletAdapter: adapter,
        registry,
        roomManager: {
            resolveRoomNumber(roomId) {
                return roomId === "Keah" ? 1 : null;
            }
        },
        blockchainMonitor,
        eventBus,
        logger: createLogger(),
        env
    });

    return {
        dataDir,
        persistence,
        repository,
        worker,
        adapter,
        sends,
        watches,
        balances,
        eventBus,
        env,
        cleanup() {
            worker.shutdown();
            persistence.shutdown({ checkpoint: false });
            rmSync(dataDir, { recursive: true, force: true });
        }
    };
}

test("sweep feature flag is off by default and independent of intake", () => {
    assert.equal(isRoomWalletResidualSweepEnabled({}), false);
    assert.equal(isRoomWalletResidualSweepEnabled({ ROOM_WALLET_RESIDUAL_SWEEP_ENABLED: "true" }), true);
    assert.equal(isRoomWalletResidualSweepEnabled({ ROOM_WALLET_RESIDUAL_SWEEP_ENABLED: "1" }), true);
    assert.equal(isRoomWalletResidualSweepEnabled({ ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET" }), false);
    assert.equal(isRoomWalletPaymentIntakeEnabled({ ROOM_WALLET_RESIDUAL_SWEEP_ENABLED: "true" }), false);
});

test("missing and invalid Residues destinations fail closed", () => {
    assert.equal(resolveResiduesWalletDestination({}).code, "RESIDUES_DESTINATION_MISSING");
    assert.equal(resolveResiduesWalletDestination({ TON_RESIDUES_EXPECTED_ADDRESS: "" }).ok, false);
    assert.equal(
        resolveResiduesWalletDestination({ TON_RESIDUES_EXPECTED_ADDRESS: "not-a-ton-address" }).code,
        "RESIDUES_DESTINATION_INVALID"
    );
    const valid = resolveResiduesWalletDestination({
        TON_RESIDUES_EXPECTED_ADDRESS: RESIDUES_ADDRESS
    });
    assert.equal(valid.ok, true);
    assert.equal(valid.address, RESIDUES_ADDRESS);

    const fallback = resolveResiduesWalletDestination({
        TON_REIMBURSEMENT_EXPECTED_ADDRESS: RESIDUES_ADDRESS
    });
    assert.equal(fallback.ok, true);
    assert.equal(fallback.address, RESIDUES_ADDRESS);
    assert.equal(fallback.compatibility, true);
});

test("disabled worker never sends", async () => {
    const harness = createHarness({ enabled: false });

    try {
        const result = await harness.worker.processRoom(1);
        assert.equal(result.code, "SWEEP_DISABLED");
        assert.equal(harness.sends.length, 0);
        assert.equal(harness.repository.listActive().length, 0);
    } finally {
        harness.cleanup();
    }
});

test("balance below 0.50 does not sweep", async () => {
    const harness = createHarness({ balanceNano: 499_999_999n });

    try {
        const result = await harness.worker.processRoom(1);
        assert.equal(result.ok, false);
        assert.equal(result.code, "BELOW_RESIDUAL_TRIGGER");
        assert.equal(harness.sends.length, 0);
        assert.equal(harness.repository.listActive().length, 0);
    } finally {
        harness.cleanup();
    }
});

test("exactly 0.50 Gram sends 0.49 with 0.01 source reserve", async () => {
    const harness = createHarness({ balanceNano: 500_000_000n });

    try {
        const result = await harness.worker.processRoom(1);
        assert.equal(result.ok, true);
        assert.equal(result.code, "SUBMITTED");
        assert.equal(harness.sends.length, 1);
        assert.equal(harness.sends[0].roomNumber, 1);
        assert.equal(harness.sends[0].amountNano, 490_000_000n);
        assert.equal(harness.sends[0].sourceReserveNano, 10_000_000n);
        assert.equal(harness.sends[0].destination, RESIDUES_ADDRESS);
        assert.notEqual(harness.sends[0].amountNano, 484_000_000n);
        assert.notEqual(harness.sends[0].sourceReserveNano, 6_000_000n);
        assert.equal(result.record.payload.amountNano, "490000000");
        assert.equal(result.record.payload.roomNumber, 1);
        assert.equal(result.record.payload.sourceAddress, SOURCE.address);
        assert.equal(result.record.payload.destinationAddress, RESIDUES_ADDRESS);
        assert.equal(result.record.payload.txHash, "sweep_tx_hash_1");
        assert.equal(result.record.payload.status, RESIDUAL_SWEEP_STATUS.PROCESSING);
        assert.equal(result.record.payload.completedFinancialEvent, false);
        assert.equal(result.record.gameId, null);
        assert.equal(harness.watches.length, 1);
        assert.equal(harness.watches[0].kind, "RESIDUAL_SWEEP");
        assert.equal(harness.watches[0].address, SOURCE.address);
        assert.equal(harness.watches[0].transactionId, "sweep_tx_hash_1");
    } finally {
        harness.cleanup();
    }
});

test("above 0.50 still sends exactly 0.49 Gram", async () => {
    const harness = createHarness({ balanceNano: 900_000_000n });

    try {
        const result = await harness.worker.processRoom(1);
        assert.equal(result.ok, true);
        assert.equal(harness.sends[0].amountNano, ROOM_WALLET_POLICY.residualSweepNano);
    } finally {
        harness.cleanup();
    }
});

test("missing Residues destination does not send", async () => {
    const harness = createHarness({ residuesAddress: "" });

    try {
        const result = await harness.worker.processRoom(1);
        assert.equal(result.code, "RESIDUES_DESTINATION_MISSING");
        assert.equal(harness.sends.length, 0);
    } finally {
        harness.cleanup();
    }
});

test("invalid Residues destination does not send", async () => {
    const harness = createHarness({ residuesAddress: "bogus" });

    try {
        const result = await harness.worker.processRoom(1);
        assert.equal(result.code, "RESIDUES_DESTINATION_INVALID");
        assert.equal(harness.sends.length, 0);
    } finally {
        harness.cleanup();
    }
});

test("roomNumber maps through registry; roomId is never a wallet index", async () => {
    const harness = createHarness();

    try {
        const unresolved = await harness.worker.enqueueFromSettlement({
            roomId: "Keah"
        });
        assert.equal(unresolved.ok, true);
        assert.equal(harness.sends[0].roomNumber, 1);
        assert.notEqual(Number("Keah"), 1);

        const second = await harness.worker.enqueueFromSettlement({
            roomId: "Keah",
            gameId: "game_should_not_select_wallet"
        });
        assert.equal(second.code, "IN_FLIGHT_HAS_TXHASH");
        assert.equal(harness.sends.length, 1);
    } finally {
        harness.cleanup();
    }
});

test("SETTLEMENT_CONFIRMED trigger uses payload roomNumber", async () => {
    const harness = createHarness();
    harness.worker.initialize();

    try {
        harness.eventBus.emit({
            source: "test",
            type: EVENT_TYPES.SETTLEMENT_CONFIRMED,
            payload: {
                roomNumber: 1,
                roomId: "Keah",
                gameId: "game-settled"
            }
        });
        for (let i = 0; i < 20 && harness.sends.length === 0; i += 1) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        assert.equal(harness.sends.length, 1);
        assert.equal(harness.sends[0].roomNumber, 1);
    } finally {
        harness.cleanup();
    }
});

test("confirmation records RESIDUAL_SWEEP only after watch confirmation", async () => {
    const harness = createHarness();
    const completed = [];
    harness.eventBus.subscribe(EVENT_TYPES.RESIDUAL_SWEEP_CONFIRMED, (envelope) => {
        completed.push(envelope.payload);
    });

    try {
        const submitted = await harness.worker.processRoom(1);
        assert.equal(submitted.record.payload.completedFinancialEvent, false);

        const confirmed = await harness.worker.confirmByTransactionHash("sweep_tx_hash_1");
        assert.equal(confirmed.ok, true);
        assert.equal(confirmed.record.payload.status, RESIDUAL_SWEEP_STATUS.CONFIRMED);
        assert.equal(confirmed.record.payload.completedFinancialEvent, true);
        assert.equal(confirmed.record.payload.amountNano, "490000000");
        assert.equal(confirmed.record.payload.txHash, "sweep_tx_hash_1");
        assert.equal(confirmed.record.payload.roomNumber, 1);
        assert.equal(confirmed.record.recordType, TON_FINANCIAL_RECORD_TYPES.RESIDUAL_SWEEP);
        assert.equal(confirmed.record.gameId, null);
        assert.equal(completed.length, 1);
        assert.equal(completed[0].kind, "RESIDUAL_SWEEP");

        const types = Object.values(ROOM_LEDGER_ENTRY_TYPES);
        assert.ok(types.includes("RESIDUAL_SWEEP"));
        assert.equal(completed[0].amountNano, "490000000");
    } finally {
        harness.cleanup();
    }
});

test("duplicate and concurrent triggers create one outbound sweep", async () => {
    const harness = createHarness();

    try {
        const [first, second] = await Promise.all([
            harness.worker.processRoom(1),
            harness.worker.processRoom(1)
        ]);
        const codes = [first.code, second.code].sort();
        assert.ok(codes.includes("SUBMITTED"));
        assert.ok(codes.includes("IN_FLIGHT_HAS_TXHASH") || codes.includes("IN_FLIGHT"));
        assert.equal(harness.sends.length, 1);
        assert.equal(harness.repository.listActive().length, 1);
    } finally {
        harness.cleanup();
    }
});

test("existing txHash prevents rebroadcast on retry and restart", async () => {
    const harness = createHarness();

    try {
        await harness.worker.processRoom(1);
        const recovered = await harness.worker.recoverPending();
        assert.ok(recovered.recovered >= 1);
        const retry = await harness.worker.processRoom(1);
        assert.equal(retry.code, "IN_FLIGHT_HAS_TXHASH");
        assert.equal(harness.sends.length, 1);
        assert.equal(harness.watches.length >= 2, true);
    } finally {
        harness.cleanup();
    }
});

test("failed submission is retryable without a completed financial event", async () => {
    const harness = createHarness({
        sendImpl() {
            throw new Error("rpc_down");
        }
    });

    try {
        const result = await harness.worker.processRoom(1);
        assert.equal(result.code, "SUBMIT_FAILED");
        const record = harness.repository.listActive()[0];
        assert.equal(record.payload.status, RESIDUAL_SWEEP_STATUS.FAILED_RETRY);
        assert.equal(record.payload.completedFinancialEvent, false);
        assert.equal(record.payload.txHash, null);
    } finally {
        harness.cleanup();
    }
});

test("processing without txHash is recovered without rebroadcast", async () => {
    const harness = createHarness();

    try {
        const submitted = await harness.worker.processRoom(1);
        harness.repository.updateStatus(submitted.record.recordId, {
            status: RESIDUAL_SWEEP_STATUS.PROCESSING,
            txHash: null
        });
        harness.sends.length = 0;
        await harness.worker.recoverPending();
        assert.equal(harness.sends.length, 0);
        const record = harness.repository.findById(submitted.record.recordId);
        assert.equal(record.payload.status, RESIDUAL_SWEEP_STATUS.AWAITING_TRANSACTION_HASH);
        assert.equal(record.payload.txHash, null);
    } finally {
        harness.cleanup();
    }
});

test("bounced transaction is terminal and does not complete RESIDUAL_SWEEP", async () => {
    const harness = createHarness();
    harness.worker.initialize();

    try {
        await harness.worker.processRoom(1);
        harness.eventBus.emit({
            source: "test",
            type: EVENT_TYPES.TRANSACTION_FAILED,
            payload: {
                kind: "RESIDUAL_SWEEP",
                transactionId: "sweep_tx_hash_1",
                reason: "transaction_failed"
            }
        });
        await new Promise((resolve) => setImmediate(resolve));
        const record = harness.repository.listActive()[0];
        assert.equal(record.payload.status, RESIDUAL_SWEEP_STATUS.FAILED_TERMINAL);
        assert.equal(record.payload.completedFinancialEvent, false);
    } finally {
        harness.cleanup();
    }
});

test("in-flight uniqueness rejects a second durable record for the same roomNumber", () => {
    const harness = createHarness();

    try {
        harness.repository.create({
            roomNumber: 1,
            sourceAddress: SOURCE.address,
            destinationAddress: RESIDUES_ADDRESS,
            observedBalanceNano: 500_000_000n
        });
        assert.throws(
            () => harness.repository.create({
                roomNumber: 1,
                sourceAddress: SOURCE.address,
                destinationAddress: RESIDUES_ADDRESS,
                observedBalanceNano: 500_000_000n
            }),
            DuplicateRecordError
        );
    } finally {
        harness.cleanup();
    }
});

test("app.js wires the sweep worker and does not enable the flag", () => {
    const source = readFileSync(
        fileURLToPath(new URL("../app.js", import.meta.url)),
        "utf8"
    );

    assert.match(source, /RoomWalletResidualSweepWorker/);
    assert.match(source, /new RoomWalletResidualSweepRepository/);
    assert.match(source, /this\._roomWalletResidualSweepWorker\.initialize\(\)/);
    assert.equal(source.includes("ROOM_WALLET_RESIDUAL_SWEEP_ENABLED: \"true\""), false);
    assert.equal(/ROOM_WALLET_PAYMENT_INTAKE_MODE\s*=\s*["']ROOM_WALLET["']/.test(source), false);
});
