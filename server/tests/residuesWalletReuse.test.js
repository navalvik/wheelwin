/**
 * Reimbursement Wallet → Residues Wallet role migration.
 * Test mnemonic only (BIP39 abandon/about). Never production secrets.
 * Mocked TON only. No funding, no deploy, no chain send, no balance move.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { SECRET_ENV_KEYS } from "../config/secrets.js";
import { EventBus } from "../events/EventBus.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { ROOM_WALLET_POLICY } from "../payment/roomWallet/RoomWalletFinancialPolicy.js";
import { RoomWalletRegistry } from "../payment/roomWallet/RoomWalletRegistry.js";
import { RoomWalletResidualSweepRepository } from "../payment/roomWallet/RoomWalletResidualSweepRepository.js";
import { RoomWalletResidualSweepWorker } from "../payment/roomWallet/RoomWalletResidualSweepWorker.js";
import {
    RESIDUES_WALLET_CONTRACT_TYPE,
    RESIDUES_WALLET_WORKCHAIN,
    assertSweepSourceDiffersFromDestination,
    deriveResiduesWalletIdentity,
    resolveResiduesWalletDestination,
    verifyResiduesWalletIdentity
} from "../payment/roomWallet/ResiduesWalletConfig.js";
import {
    isRoomWalletPaymentIntakeEnabled,
    isRoomWalletResidualSweepEnabled
} from "../payment/roomWallet/roomWalletConfig.js";
import { DeploymentReimbursementRepository } from "../payment/reimbursement/DeploymentReimbursementRepository.js";
import { DeploymentReimbursementWorker } from "../payment/reimbursement/DeploymentReimbursementWorker.js";
import {
    REIMBURSEMENT_TRANSFER_RESULT,
    ReimbursementTransferService
} from "../payment/reimbursement/ReimbursementTransferService.js";
import { ReimbursementWalletAdapter } from "../payment/reimbursement/ReimbursementWalletAdapter.js";
import {
    deriveReimbursementWalletIdentity,
    isReimbursementSendAllowed,
    isReimbursementSendPermanentlyRetired
} from "../payment/reimbursement/ReimbursementWalletConfig.js";
import { DEPLOYMENT_REIMBURSEMENT_STATUS } from "../payment/reimbursement/deploymentReimbursementStates.js";
import { createDummyRoomWalletEntry } from "./helpers/dummyRoomWallet.js";

const TEST_MNEMONIC = [
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "about"
].join(" ");

const OTHER_MNEMONIC = [
    "legal", "winner", "thank", "year", "wave", "sausage", "worth", "useful",
    "legal", "winner", "thank", "year", "wave", "sausage", "worth", "useful",
    "legal", "winner", "thank", "year", "wave", "sausage", "worth", "yellow"
].join(" ");

const SOURCE = createDummyRoomWalletEntry(1);
const OTHER_ROOM = createDummyRoomWalletEntry(2);
const __dirname = dirname(fileURLToPath(import.meta.url));

function createLogger() {
    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        startupLine() {}
    };
}

test("TON_RESIDUES_MNEMONIC is classified as a secret", () => {
    assert.equal(SECRET_ENV_KEYS.includes("TON_RESIDUES_MNEMONIC"), true);
    assert.equal(SECRET_ENV_KEYS.includes("TON_REIMBURSEMENT_MNEMONIC"), true);
});

test("same mnemonic produces the same V4R2 workchain-0 Residues address", async () => {
    const residues = await deriveResiduesWalletIdentity(TEST_MNEMONIC);
    const reimbursement = await deriveReimbursementWalletIdentity(TEST_MNEMONIC);
    const keyPair = await mnemonicToPrivateKey(TEST_MNEMONIC.split(/\s+/));
    const wallet = WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    });
    const expected = wallet.address.toString({ bounceable: true, urlSafe: true });

    assert.equal(residues.address, reimbursement.address);
    assert.equal(residues.address, expected);
    assert.equal(residues.workchain, 0);
    assert.equal(residues.workchain, RESIDUES_WALLET_WORKCHAIN);
    assert.equal(residues.contractType, RESIDUES_WALLET_CONTRACT_TYPE);
    assert.equal(residues.walletId, wallet.walletId);
});

test("Residues expected address validation succeeds for the derived address", async () => {
    const identity = await deriveResiduesWalletIdentity(TEST_MNEMONIC);
    const verified = await verifyResiduesWalletIdentity({
        TON_RESIDUES_MNEMONIC: TEST_MNEMONIC,
        TON_RESIDUES_EXPECTED_ADDRESS: identity.address
    });

    assert.equal(verified.ok, true);
    assert.equal(verified.code, "OK");
    assert.equal(verified.derivedAddress, identity.address);
    assert.equal(verified.expectedAddress, identity.address);
    assert.equal(verified.mnemonicSource, "TON_RESIDUES_MNEMONIC");
    assert.equal(verified.workchain, 0);
});

test("legacy reimbursement env maps to the same Residues identity", async () => {
    const identity = await deriveResiduesWalletIdentity(TEST_MNEMONIC);
    const destination = resolveResiduesWalletDestination({
        TON_REIMBURSEMENT_EXPECTED_ADDRESS: identity.address
    });
    const verified = await verifyResiduesWalletIdentity({
        TON_REIMBURSEMENT_MNEMONIC: TEST_MNEMONIC,
        TON_REIMBURSEMENT_EXPECTED_ADDRESS: identity.address
    });

    assert.equal(destination.ok, true);
    assert.equal(destination.address, identity.address);
    assert.equal(destination.compatibility, true);
    assert.equal(verified.ok, true);
    assert.equal(verified.derivedAddress, identity.address);
    assert.equal(verified.mnemonicSource, "TON_REIMBURSEMENT_MNEMONIC");
});

test("canonical Residues env is preferred when it matches the compatibility pin", async () => {
    const identity = await deriveResiduesWalletIdentity(TEST_MNEMONIC);
    const destination = resolveResiduesWalletDestination({
        TON_RESIDUES_EXPECTED_ADDRESS: identity.address,
        TON_REIMBURSEMENT_EXPECTED_ADDRESS: identity.address
    });

    assert.equal(destination.ok, true);
    assert.equal(destination.source, "TON_RESIDUES_EXPECTED_ADDRESS");
    assert.equal(destination.compatibility, false);
});

test("mismatch between derived Residues address and expected pin fails closed", async () => {
    const identity = await deriveResiduesWalletIdentity(TEST_MNEMONIC);
    const verified = await verifyResiduesWalletIdentity({
        TON_RESIDUES_MNEMONIC: TEST_MNEMONIC,
        TON_RESIDUES_EXPECTED_ADDRESS: OTHER_ROOM.address
    });

    assert.equal(verified.ok, false);
    assert.equal(verified.code, "ADDRESS_MISMATCH");
    assert.equal(verified.derivedAddress, identity.address);
    assert.notEqual(verified.expectedAddress, identity.address);
});

test("dual expected addresses that are not the same identity fail closed", () => {
    const conflict = resolveResiduesWalletDestination({
        TON_RESIDUES_EXPECTED_ADDRESS: SOURCE.address,
        TON_REIMBURSEMENT_EXPECTED_ADDRESS: OTHER_ROOM.address
    });

    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, "RESIDUES_ADDRESS_CONFLICT");
});

test("dual mnemonics that are not the same identity fail closed", async () => {
    let otherOk = true;

    try {
        await deriveResiduesWalletIdentity(OTHER_MNEMONIC);
    } catch {
        otherOk = false;
    }

    if (!otherOk) {
        const verified = await verifyResiduesWalletIdentity({
            TON_RESIDUES_MNEMONIC: TEST_MNEMONIC,
            TON_REIMBURSEMENT_MNEMONIC: OTHER_MNEMONIC,
            TON_RESIDUES_EXPECTED_ADDRESS: (await deriveResiduesWalletIdentity(TEST_MNEMONIC)).address
        });
        assert.equal(verified.ok, false);
        assert.ok(
            verified.code === "MNEMONIC_INVALID"
            || verified.code === "RESIDUES_MNEMONIC_CONFLICT"
        );
        return;
    }

    const verified = await verifyResiduesWalletIdentity({
        TON_RESIDUES_MNEMONIC: TEST_MNEMONIC,
        TON_REIMBURSEMENT_MNEMONIC: OTHER_MNEMONIC
    });

    assert.equal(verified.ok, false);
    assert.equal(verified.code, "RESIDUES_MNEMONIC_CONFLICT");
});

test("old reimbursement flags cannot reactivate a send path", async () => {
    assert.equal(isReimbursementSendPermanentlyRetired(), true);
    assert.equal(isReimbursementSendAllowed({}), false);
    assert.equal(
        isReimbursementSendAllowed({
            DEPLOYMENT_REIMBURSEMENT_ENABLED: "true",
            REIMBURSEMENT_ENABLED: "true"
        }),
        false
    );

    const transfer = new ReimbursementTransferService({
        env: {
            DEPLOYMENT_REIMBURSEMENT_ENABLED: "true",
            REIMBURSEMENT_ENABLED: "true"
        }
    });
    await transfer.initialize();
    const sent = await transfer.sendReimbursement({ payload: { amountTon: "0.01" } });
    assert.equal(sent.ok, false);
    assert.equal(sent.code, REIMBURSEMENT_TRANSFER_RESULT.SEND_RETIRED);
    assert.equal(sent.txHash, null);
    transfer.shutdown();

    let broadcastCalls = 0;
    const adapter = new ReimbursementWalletAdapter({
        tonService: {
            async broadcastTransaction() {
                broadcastCalls += 1;
                return { hash: "must-not-broadcast" };
            },
            async getBalance() {
                return 2_000_000_000n;
            },
            async getSeqno() {
                return 1;
            }
        },
        env: {
            TON_REIMBURSEMENT_MNEMONIC: TEST_MNEMONIC,
            TON_REIMBURSEMENT_EXPECTED_ADDRESS:
                (await deriveResiduesWalletIdentity(TEST_MNEMONIC)).address
        }
    });

    const adapterResult = await adapter.sendTransfer({
        destination: OTHER_ROOM.address,
        amountTon: "0.02"
    });

    assert.equal(adapterResult.ok, false);
    assert.equal(adapterResult.code, "SEND_RETIRED");
    assert.equal(broadcastCalls, 0);
    adapter.shutdown();
});

test("old reimbursement worker, retry, recovery, and restart cannot send TON", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-residues-reimb-"));
    const persistence = new TonFinancialPersistence({
        dataDir,
        logger: createLogger(),
        autoCheckpoint: false
    });
    persistence.initialize();
    const repository = new DeploymentReimbursementRepository({
        persistence,
        tonNetwork: "testnet"
    });

    repository.create({
        gameId: "game_residues_pending",
        roomId: "room_r",
        contractId: "contract_r",
        deploymentTxHash: "deploy:residues",
        deployWallet: OTHER_ROOM.address,
        reimbursementWallet: SOURCE.address,
        deploymentCostSnapshotId: "snap:residues",
        amountTon: "0.02",
        status: DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING
    });

    let sendCalls = 0;
    const worker = new DeploymentReimbursementWorker({
        repository,
        transferService: {
            async sendReimbursement() {
                sendCalls += 1;
                return { ok: true, code: "SENT", txHash: "must-not" };
            }
        },
        env: {
            DEPLOYMENT_REIMBURSEMENT_ENABLED: "true",
            REIMBURSEMENT_ENABLED: "true"
        }
    });

    worker.initialize();
    assert.equal(worker._timer, null);

    const first = await worker.processQueue();
    assert.equal(first.skipped, "send_permanently_retired");
    assert.equal(first.claimed, 0);
    assert.equal(sendCalls, 0);

    worker.shutdown();
    worker.initialize();
    const restarted = await worker.processQueue();
    assert.equal(restarted.skipped, "send_permanently_retired");
    assert.equal(sendCalls, 0);
    assert.equal(
        repository.findByGameId("game_residues_pending").payload.status,
        DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING
    );
    assert.equal(
        repository.findByGameId("game_residues_pending").payload.txHash,
        null
    );

    worker.shutdown();
    persistence.shutdown({ checkpoint: false });
    rmSync(dataDir, { recursive: true, force: true });
});

test("source Room Wallet and Residues Wallet must differ", () => {
    const same = assertSweepSourceDiffersFromDestination(SOURCE.address, SOURCE.address);
    const different = assertSweepSourceDiffersFromDestination(SOURCE.address, OTHER_ROOM.address);

    assert.equal(same.ok, false);
    assert.equal(same.code, "SOURCE_EQUALS_DESTINATION");
    assert.equal(different.ok, true);
});

test("sweep remains disabled unless explicitly enabled and does not send", async () => {
    assert.equal(isRoomWalletResidualSweepEnabled({}), false);
    assert.equal(
        isRoomWalletPaymentIntakeEnabled({ ROOM_WALLET_RESIDUAL_SWEEP_ENABLED: "true" }),
        false
    );

    const identity = await deriveResiduesWalletIdentity(TEST_MNEMONIC);
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-residues-sweep-off-"));
    const persistence = new TonFinancialPersistence({
        dataDir,
        logger: createLogger(),
        autoCheckpoint: false
    });
    persistence.initialize();
    const repository = new RoomWalletResidualSweepRepository({
        persistence,
        tonNetwork: "testnet"
    });
    const registry = new RoomWalletRegistry({
        entries: [{ roomNumber: 1, address: SOURCE.address, network: "testnet" }]
    });
    const sends = [];
    const eventBus = new EventBus({
        logger: createLogger(),
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const worker = new RoomWalletResidualSweepWorker({
        repository,
        registry,
        eventBus,
        logger: createLogger(),
        env: {
            ROOM_WALLET_RESIDUAL_SWEEP_ENABLED: "",
            TON_RESIDUES_EXPECTED_ADDRESS: identity.address,
            TON_RESIDUES_MNEMONIC: TEST_MNEMONIC
        },
        roomWalletAdapter: {
            async getBalance() {
                return 500_000_000n;
            },
            async sendTransfer(input) {
                sends.push(input);
                return { ok: true, txHash: "must-not" };
            }
        }
    });

    worker.initialize();
    const result = await worker.processRoom(1);
    assert.equal(result.code, "SWEEP_DISABLED");
    assert.equal(sends.length, 0);
    worker.shutdown();
    persistence.shutdown({ checkpoint: false });
    rmSync(dataDir, { recursive: true, force: true });
});

test("self-transfer from Room Wallet to Residues of the same address is refused", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-residues-self-"));
    const persistence = new TonFinancialPersistence({
        dataDir,
        logger: createLogger(),
        autoCheckpoint: false
    });
    persistence.initialize();
    const repository = new RoomWalletResidualSweepRepository({
        persistence,
        tonNetwork: "testnet"
    });
    const registry = new RoomWalletRegistry({
        entries: [{ roomNumber: 1, address: SOURCE.address, network: "testnet" }]
    });
    const sends = [];
    const eventBus = new EventBus({
        logger: createLogger(),
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const worker = new RoomWalletResidualSweepWorker({
        repository,
        registry,
        eventBus,
        logger: createLogger(),
        env: {
            ROOM_WALLET_RESIDUAL_SWEEP_ENABLED: "true",
            TON_RESIDUES_EXPECTED_ADDRESS: SOURCE.address
        },
        roomWalletAdapter: {
            async getBalance() {
                return 500_000_000n;
            },
            async sendTransfer(input) {
                sends.push(input);
                return { ok: true, txHash: "must-not" };
            }
        }
    });

    worker.initialize();
    const result = await worker.processRoom(1);
    assert.equal(result.ok, false);
    assert.equal(result.code, "SOURCE_EQUALS_DESTINATION");
    assert.equal(sends.length, 0);
    worker.shutdown();
    persistence.shutdown({ checkpoint: false });
    rmSync(dataDir, { recursive: true, force: true });
});

test("financial residual-sweep model is unchanged", () => {
    assert.equal(ROOM_WALLET_POLICY.residualTriggerNano, 500_000_000n);
    assert.equal(ROOM_WALLET_POLICY.residualSweepNano, 490_000_000n);
    assert.equal(ROOM_WALLET_POLICY.residualRetainedFloorNano, 10_000_000n);
    assert.equal(ROOM_WALLET_POLICY.residualSweepGasNano, 6_000_000n);
    assert.equal(ROOM_WALLET_POLICY.residualSafetyMarginNano, 4_000_000n);
    assert.equal(
        ROOM_WALLET_POLICY.residualSweepGasNano
            + ROOM_WALLET_POLICY.residualSafetyMarginNano,
        ROOM_WALLET_POLICY.residualRetainedFloorNano
    );
    assert.notEqual(
        ROOM_WALLET_POLICY.residualSweepNano,
        ROOM_WALLET_POLICY.residualSweepNano - ROOM_WALLET_POLICY.residualSweepGasNano
    );
});

test("adapter and worker sources do not contain a live reimbursement broadcast", () => {
    const adapterSrc = readFileSync(
        join(__dirname, "../payment/reimbursement/ReimbursementWalletAdapter.js"),
        "utf8"
    );
    const workerSrc = readFileSync(
        join(__dirname, "../payment/reimbursement/DeploymentReimbursementWorker.js"),
        "utf8"
    );

    assert.match(adapterSrc, /send permanently retired/);
    assert.equal(/broadcastTransaction/.test(adapterSrc), false);
    assert.equal(/createTransfer/.test(adapterSrc), false);
    assert.match(workerSrc, /send permanently retired/);
    assert.equal(/sendReimbursement/.test(workerSrc), false);
    assert.equal(/setInterval/.test(workerSrc), false);
});
