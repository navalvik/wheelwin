import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../../events/EventBus.js";
import { EVENT_TYPES } from "../../events/EventTypes.js";
import { RoomManager } from "../../managers/RoomManager.js";
import { ROOM_STATUS } from "../../models/RoomStatus.js";
import { GameStartAuthorization } from "../../gameplay/GameStartAuthorization.js";
import { PaymentIntent } from "../../payment/PaymentIntent.js";
import { PAYMENT_INTENT_STATE } from "../../payment/PaymentIntentStatus.js";
import { ROOM_WALLET_POOL_SIZE } from "../../payment/RoomPaymentConstants.js";
import { LEDGER_ENTRY_KIND } from "../../payment/ledger/LedgerConstants.js";
import { REFUND_STATE, RefundObligation } from "../../payment/refund/RefundObligation.js";
import { RefundLifecycleCoordinator, TestnetRefundProvider } from "../../payment/refund/RefundLifecycleCoordinator.js";
import { SyntheticTonSettlementEvidenceProvider } from "../helpers/syntheticTonSettlementEvidence.js";
import {
    assertTestnetNetworkIdentity,
    buildPaymentRuntime
} from "../../payment/runtime/PaymentRuntimeFactory.js";
import { bindPaymentRuntimeToApplication } from "../../payment/runtime/PaymentApplicationBinder.js";

const BASE_MS = 1_700_100_000_000;
const CREATED_AT = BASE_MS;
const NOW_MS = BASE_MS + 5_000;
const TRANSFER_SECONDS = Math.floor(NOW_MS / 1_000);
const SYNTHETIC_API_KEY = "SYNTHETIC-TONCENTER-TEST-KEY-NOT-REAL";
const TESTNET_PAYER = `0:${"a".repeat(64)}`;
const TESTNET_WALLET = `0:${"b".repeat(64)}`;

const TOTAL_SECTIONS = 12;
let assertions = 0;
let sections = 0;

function check(value, message) { assert.ok(value, message); assertions += 1; }
function equal(actual, expected, message) { assert.equal(actual, expected, message); assertions += 1; }
function throws(fn, matcher, message) { assert.throws(fn, matcher, message); assertions += 1; }
async function rejects(promise, matcher, message) { await assert.rejects(promise, matcher, message); assertions += 1; }
async function section(name, callback) {
    const before = assertions;
    await callback();
    sections += 1;
    process.stdout.write(`[${sections}/${TOTAL_SECTIONS}] PASS ${name} (${assertions - before} assertions)\n`);
}

function crc16Xmodem(bytes) {
    let register = 0;
    for (const byte of bytes) {
        register ^= byte << 8;
        for (let bit = 0; bit < 8; bit += 1) {
            register = (register & 0x8000) ? ((register << 1) ^ 0x1021) : (register << 1);
            register &= 0xffff;
        }
    }
    return Buffer.from([register >> 8, register & 0xff]);
}

function syntheticAddress(seed) {
    const hash = createHash("sha256").update(`payment-runtime:${seed}`).digest();
    const body = Buffer.concat([Buffer.from([0x11, 0]), hash]);
    return Buffer.concat([body, crc16Xmodem(body)]).toString("base64url");
}

function writeCatalog(root) {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const catalogPath = join(configDir, "synthetic-public-wallets.json");
    const wallets = Array.from({ length: ROOM_WALLET_POOL_SIZE }, (_, index) => ({
        roomNumber: index + 1,
        address: syntheticAddress(`wallet-${index + 1}`),
        publicKey: null,
        workchain: 0,
        network: "testnet"
    }));
    writeFileSync(catalogPath, `${JSON.stringify(wallets)}\n`, "utf8");
    return catalogPath;
}

function makeTemp() {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-payment-runtime-"));
    return { root, catalogPath: writeCatalog(root), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Build + initialize a runtime on `root.ncDir` using the synthetic finality
 * evidence provider and an injectable transaction payload, exactly mirroring
 * the proven adapter-test recipe (deterministic clock, no network).
 */
function buildRuntime(root, catalogPath, { now = () => NOW_MS, paymentDataDirName = "payment-data" } = {}) {
    const state = { payload: { transactions: [], address_book: {} } };
    const evidence = new SyntheticTonSettlementEvidenceProvider({ nowProvider: now });
    const runtime = buildPaymentRuntime({
        dataDir: join(root, paymentDataDirName),
        network: "testnet",
        walletCatalogPath: catalogPath,
        nowProvider: now,
        logger: null,
        fetchImpl: async () => ({ status: 200, json: async () => state.payload }),
        apiKeyProvider: () => SYNTHETIC_API_KEY,
        settlementEvidenceProvider: evidence
    });
    runtime.initialize();
    return { runtime, setPayload: (payload) => { state.payload = payload; } };
}

function emptyPayload(...transactions) {
    return { transactions, address_book: {} };
}

function transactionFor(intent, wallet, overrides = {}) {
    const body = {
        account: wallet.address,
        hash: createHash("sha256")
            .update(`${intent.paymentReference}:${overrides.suffix ?? "transaction"}`)
            .digest("hex"),
        now: overrides.nowSeconds ?? TRANSFER_SECONDS,
        description: { aborted: false, compute_ph: { success: true }, action: { success: true } },
        in_msg: {
            source: overrides.source ?? intent.expectedSender,
            destination: wallet.address,
            value: String(overrides.amountAtomic ?? intent.amountAtomic),
            message_content: {
                decoded: {
                    type: "text_comment",
                    comment: `WW1:${intent.paymentReference}`
                }
            }
        }
    };
    return body;
}

function threePlayerDescriptor(roomId, amounts = [1, 2, 3]) {
    const requiredPlayers = [0, 1, 2].map((index) => ({
        roomId,
        paymentReference: `WW-RT-PLAYER-${index}`,
        playerId: `rt-player-${index}`,
        expectedSender: syntheticAddress(`rt-sender-${index}`),
        amountAtomic: amounts[index] * 1_000_000_000
    }));
    return {
        roomId,
        roomCreatedAt: CREATED_AT,
        network: "testnet",
        asset: "TON",
        stakeLedgerRelation: "ONE_PLAYER_STAKE_AND_PRINCIPAL_PER_PAYMENT",
        requiredPlayers
    };
}

// ---------------------------------------------------------------------------
// GameStartAuthorization stub collaborators (proven shape: the exact wiring the
// production server supplies, so the barrier is exercised for real).
// ---------------------------------------------------------------------------
function makeAuthorization(paymentGate, room, { gameId = "game-rt" } = {}) {
    const listeners = new Map();
    const emitted = [];
    const eventBus = {
        subscribe(type, handler) {
            const handlers = listeners.get(type) ?? new Set();
            handlers.add(handler);
            listeners.set(type, handlers);
        },
        unsubscribe(type, handler) { listeners.get(type)?.delete(handler); },
        emit(envelope) { emitted.push(envelope); },
        fire(type, payload) {
            for (const handler of listeners.get(type) ?? []) handler({ payload });
        }
    };
    const authorization = new GameStartAuthorization({
        logger: { info() {} },
        eventBus,
        roomManager: { getRoom: () => room },
        playerManager: { getIdentity: (playerId) => ({ playerId }) },
        gameManager: {
            getPendingGameplayGameId: () => gameId,
            getGame: () => ({ id: gameId })
        },
        configurationEngine: {
            getConfiguration: () => ({ traceSeed: "seed" }),
            validateConfiguration() {}
        },
        paymentGate,
        roomConfig: { gameStartAuthorizationDurationMs: 60_000 }
    });
    authorization.initialize();
    const authorizedCount = () =>
        emitted.filter(({ type }) => type === EVENT_TYPES.GAME_START_AUTHORIZED).length;
    return { authorization, eventBus, emitted, authorizedCount };
}

async function run() {
    await section("network identity enforced; Mainnet never selected", () => {
        equal(assertTestnetNetworkIdentity("testnet").globalId, -3, "Testnet identity resolves to global ID -3");
        equal(assertTestnetNetworkIdentity("  TestNet ").network, "testnet", "network identity is case-insensitive");
        throws(() => assertTestnetNetworkIdentity("mainnet"), /not selectable/, "Mainnet is rejected at the factory boundary");
        throws(() => assertTestnetNetworkIdentity(undefined), /not selectable/, "a missing network never silently becomes Mainnet");
        const t = makeTemp();
        try {
            throws(() => buildPaymentRuntime({ dataDir: join(t.root, "d"), network: "mainnet", walletCatalogPath: t.catalogPath }),
                /Testnet/, "building a Mainnet runtime fails closed");
        } finally { t.cleanup(); }
    });

    await section("startup builds the runtime once and enforces the three-player barrier via the real gate", async () => {
        const t = makeTemp();
        try {
            const { runtime, setPayload } = buildRuntime(t.root, t.catalogPath);
            check(runtime.initialized, "runtime initializes durable stores");
            const caps = runtime.getCapabilities();
            equal(caps.globalId, -3, "runtime capability reports Testnet global ID -3");
            equal(caps.outgoingRefundTransfersEnabled, false, "runtime reports outgoing refunds disabled (no signer)");
            equal(caps.livePaymentAcceptanceEnabled, false, "live payment acceptance remains disabled");

            // Bind to a real RoomManager + GameStartAuthorization (the app wiring).
            const logger = { info() {}, warn() {}, error() {} };
            const eventBus = new EventBus({ logger, eventBusConfig: { logEvents: false, showDebugPanel: false } });
            eventBus.initialize();
            const roomManager = new RoomManager({ logger, eventBus, roomConfig: { maxPlayers: 3 } });
            roomManager.initialize();
            roomManager.attachSetupSessionLifecycle({ createForRoom: () => ({}), abortForRoom() {} });
            const binding = bindPaymentRuntimeToApplication(runtime, { roomManager, logger });
            check(typeof roomManager._refundLifecycle?.prepareClosedRoom === "function",
                "the durable refund close-hook is attached to RoomManager");

            const descriptor = threePlayerDescriptor("room-rt-gate");
            runtime.sessionAdapter.prepareRoom(descriptor);
            const playerIds = descriptor.requiredPlayers.map((p) => p.playerId);

            // Not-paid room must deny, including through the bind-time gate.
            const authz = makeAuthorization(runtime.paymentGate, {
                status: ROOM_STATUS.FULL, maxPlayers: 3, players: [...playerIds]
            });
            authz.eventBus.fire(EVENT_TYPES.VERIFY_BARRIER_COMPLETED, { roomId: descriptor.roomId });
            equal(authz.authorizedCount(), 0, "an unpaid room cannot authorize gameplay (fail closed)");

            // Settle the three independent payments one at a time through the
            // real observation + settlement path (synthetic deterministic provider).
            const wallet = runtime.paymentService.getWalletForRoom(descriptor.roomId);
            for (let index = 0; index < descriptor.requiredPlayers.length; index += 1) {
                const intent = runtime.paymentService.getPaymentIntent(
                    descriptor.requiredPlayers[index].paymentReference
                );
                setPayload(emptyPayload(transactionFor(intent, wallet)));
                await runtime.sessionAdapter.observeRoomPayments({ roomId: descriptor.roomId });
                authz.eventBus.fire(EVENT_TYPES.VERIFY_BARRIER_COMPLETED, { roomId: descriptor.roomId });
                equal(authz.authorizedCount(), index === descriptor.requiredPlayers.length - 1 ? 1 : 0,
                    `${index + 1} settled payment${index === 0 ? "" : "s"} ${index === descriptor.requiredPlayers.length - 1 ? "authorize" : "do not authorize"} gameplay`);
            }
            equal(runtime.ledger.store.listForRoom(descriptor.roomId)
                .filter((e) => e.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL).length, 3,
                "each of the three players owns one settled principal entry");

            authz.authorization.shutdown();
            paymentRuntimeShutdown(runtime);
            managerShutdown(roomManager, eventBus);
        } finally { t.cleanup(); }
    });

    await section("a partially paid room cannot start gameplay", async () => {
        const t = makeTemp();
        try {
            const { runtime, setPayload } = buildRuntime(t.root, t.catalogPath);
            const descriptor = threePlayerDescriptor("room-rt-partial");
            runtime.sessionAdapter.prepareRoom(descriptor);
            const playerIds = descriptor.requiredPlayers.map((p) => p.playerId);
            const wallet = runtime.paymentService.getWalletForRoom(descriptor.roomId);
            const intent0 = runtime.paymentService.getPaymentIntent(descriptor.requiredPlayers[0].paymentReference);
            const intent1 = runtime.paymentService.getPaymentIntent(descriptor.requiredPlayers[1].paymentReference);
            // Two independent payments settle through the real observation path.
            setPayload(emptyPayload(transactionFor(intent0, wallet), transactionFor(intent1, wallet)));
            await runtime.sessionAdapter.observeRoomPayments({ roomId: descriptor.roomId });
            equal(runtime.ledger.store.listForRoom(descriptor.roomId)
                .filter((e) => e.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL).length, 2,
                "exactly two players settled");
            const authz = makeAuthorization(runtime.paymentGate, {
                status: ROOM_STATUS.FULL, maxPlayers: 3, players: [...playerIds]
            });
            authz.eventBus.fire(EVENT_TYPES.VERIFY_BARRIER_COMPLETED, { roomId: descriptor.roomId });
            equal(authz.authorizedCount(), 0, "two paid players do not authorize gameplay");
            equal(runtime.paymentGate.getGameStartGateStatus(descriptor.roomId, playerIds).eligible, false,
                "the real gate reports a two-paid room ineligible");
            authz.authorization.shutdown();
            paymentRuntimeShutdown(runtime);
        } finally { t.cleanup(); }
    });

    // Refund-on-close scenarios driven through RoomManager.destroyRoom -> the
    // durable refund lifecycle attached by the application binder.
    await section("closing a room prepares exactly the refund obligations justified by settled payments", async () => {
        for (const confirmed of [0, 1, 2, 3]) {
            const t = makeTemp();
            try {
                const { runtime } = buildRuntime(t.root, t.catalogPath);
                const logger = { info() {}, warn() {}, error() {}, decisionTrace() {} };
                const eventBus = new EventBus({ logger, eventBusConfig: { logEvents: false, showDebugPanel: false } });
                eventBus.initialize();
                const roomManager = new RoomManager({ logger, eventBus, roomConfig: { maxPlayers: 3 } });
                roomManager.initialize();
                roomManager.attachSetupSessionLifecycle({ createForRoom: () => ({}), abortForRoom() {} });
                bindPaymentRuntimeToApplication(runtime, { roomManager, logger });

                const room = roomManager.createRoom();
                seedRoomPayments(runtime, room.roomId, confirmed);

                equal(roomManager.destroyRoom(room.roomId), true, "room is destroyed");
                const expected = confirmed;
                equal(runtime.refundStore.size, expected,
                    `${confirmed} confirmed payment(s) -> ${expected} refund obligation(s)`);
                for (const obligation of runtime.refundStore.list()) {
                    equal(obligation.networkName, "TESTNET", "obligation records TESTNET");
                    equal(obligation.globalId, -3, "obligation records global ID -3");
                    equal(obligation.roomNumber, room.roomNumber, "obligation records the public room number");
                    equal(obligation.refundDestination, TESTNET_PAYER, "obligation refunds the verified payer");
                    equal(obligation.state, REFUND_STATE.PENDING, "obligation starts PENDING (no signer yet)");
                }
                managerShutdown(roomManager, eventBus);
                paymentRuntimeShutdown(runtime);
            } finally { t.cleanup(); }
        }
    });

    await section("a late confirmed payment for a closed room reconciles without reopening gameplay", () => {
        const t = makeTemp();
        try {
            const { runtime } = buildRuntime(t.root, t.catalogPath);
            const logger = { info() {}, warn() {}, error() {}, decisionTrace() {} };
            const eventBus = new EventBus({ logger, eventBusConfig: { logEvents: false, showDebugPanel: false } });
            eventBus.initialize();
            const roomManager = new RoomManager({ logger, eventBus, roomConfig: { maxPlayers: 3 } });
            roomManager.initialize();
            roomManager.attachSetupSessionLifecycle({ createForRoom: () => ({}), abortForRoom() {} });
            const binding = bindPaymentRuntimeToApplication(runtime, { roomManager, logger });

            const room = roomManager.createRoom();
            seedRoomPayments(runtime, room.roomId, 0, "payment_seed", { keepUnconfirmedPending: true });
            roomManager.destroyRoom(room.roomId);
            equal(runtime.refundStore.size, 0, "no confirmed payment produced no obligation");

            // A payment finalizes after the room is gone.
            settleSeed(runtime, room.roomId, 0, "late_incoming_tx");
            const created = binding.reconcileLateConfirmedPayments(room.roomId);
            equal(created.length, 1, "one late confirmed payment creates one refund obligation");
            equal(runtime.refundStore.size, 1, "late obligation is durable");
            equal(runtime.refundStore.list()[0].roomNumber, room.roomNumber, "late obligation keeps the public room number");
            equal(roomManager.getRoom(room.roomId), null, "the closed room is not reopened");

            managerShutdown(roomManager, eventBus);
            paymentRuntimeShutdown(runtime);
        } finally { t.cleanup(); }
    });

    await section("restart reconstructs wallet reservations without duplication", () => {
        const t = makeTemp();
        try {
            const dataDir = join(t.root, "payment-data");
            const first = buildRuntime(t.root, t.catalogPath, { paymentDataDirName: "payment-data" });
            const descriptor = threePlayerDescriptor("room-rt-reservation");
            first.runtime.sessionAdapter.prepareRoom(descriptor);
            const walletId = first.runtime.paymentService.getWalletForRoom(descriptor.roomId).walletId;
            paymentRuntimeShutdown(first.runtime);

            // Same dataDir => a genuine restart.
            const restart = buildPaymentRuntime({
                dataDir, network: "testnet", walletCatalogPath: t.catalogPath,
                nowProvider: () => NOW_MS, logger: null,
                fetchImpl: async () => ({ status: 200, json: async () => ({ transactions: [], address_book: {} }) }),
                apiKeyProvider: () => SYNTHETIC_API_KEY,
                settlementEvidenceProvider: new SyntheticTonSettlementEvidenceProvider({ nowProvider: () => NOW_MS })
            });
            restart.initialize();
            const reservation = restart.paymentService.getWalletForRoom(descriptor.roomId);
            check(Boolean(reservation), "restart reconstructs the outstanding wallet reservation");
            equal(reservation.walletId, walletId, "reconstructs the exact recorded wallet (no silent replacement)");
            equal(restart.intentStore.listForRoom(descriptor.roomId).length, 3,
                "restart reloads the three durable payment intents");
            check(restart.intentStore.listForRoom(descriptor.roomId).every((i) => i.state === PAYMENT_INTENT_STATE.PENDING),
                "restart preserves intent states");
            paymentRuntimeShutdown(restart);
        } finally { t.cleanup(); }
    });


    await section("restarting after three settled payments preserves the wallet while prize is unplanned", () => {
        const t=makeTemp();
        try {
            const first=buildRuntime(t.root,t.catalogPath);
            const roomId="room-three-paid-no-payout";
            seedRoomPayments(first.runtime,roomId,3);
            const wallet=first.runtime.walletPool.getReservationForRoom(roomId);
            check(wallet?.walletId,"three confirmed players retain their public room wallet");
            equal(first.runtime.ledger.getConfirmedPrincipalAtomic(roomId),3_000_000_000,
                "all three native GRAM payments are durably credited");
            paymentRuntimeShutdown(first.runtime);
            const restarted=buildRuntime(t.root,t.catalogPath);
            equal(restarted.runtime.walletPool.getReservationForRoom(roomId)?.walletId,
                wallet.walletId,
                "restart must not recycle three-player paid wallet before the winner payout is prepared");
            check(restarted.runtime.paymentService.countOpenObligations(roomId)>0,
                "three SETTLED intents leave an open financial obligation until prize or refunds close");
            paymentRuntimeShutdown(restarted.runtime);
        } finally {t.cleanup();}
    });

    await section("restart keeps an unpaid two-recipient prize wallet and releases after both real settlement entries", () => {
        const t=makeTemp();
        try {
            const roomId="room-three-paid-prize";
            const payoutId="payout_"+"c".repeat(32);
            const first=buildRuntime(t.root,t.catalogPath);
            seedRoomPayments(first.runtime,roomId,3);
            const wallet=first.runtime.walletPool.getReservationForRoom(roomId);
            const amounts={
                winner:{feeAtomic:2_000_000},
                owner:{feeAtomic:2_000_000}
            };
            first.runtime.ledger.planPayout({
                payoutId,roomId,safetyMarginAtomic:10_000_000,
                winner:{recipientId:"seed-player-1",address:TESTNET_PAYER},
                owner:{recipientId:"WheelWin",address:syntheticAddress("owner-wallet")},
                networkFees:amounts,nowMs:NOW_MS
            });
            equal(first.runtime.ledger.countOpenObligations(roomId),2,
                "an unsettled winner and owner create two independent outstanding obligations");
            paymentRuntimeShutdown(first.runtime);
            const restarted=buildRuntime(t.root,t.catalogPath);
            equal(restarted.runtime.walletPool.getReservationForRoom(roomId)?.walletId,
                wallet.walletId,"wallet must remain reserved after a restart with two unpaid payout obligations");
            throws(()=>restarted.runtime.paymentService.releaseWalletForRoom(roomId),
                /unresolved|obligation|blocked/i,"wallet release rejects an unsettled prize");
            // Settled entries are booked only as a test fixture of externally
            // verified chain finality. No real RPC or outgoing transfers.
            for(const recipientId of ["seed-player-1","WheelWin"]){
                restarted.runtime.ledger.settlePayout({
                    payoutId,recipientId,
                    executionResult:{transactionId:"synthetic-final-"+recipientId,
                        actualFeeAtomic:1_000_000,settledAtMs:NOW_MS}
                });
            }
            equal(restarted.runtime.ledger.countOpenObligations(roomId),0,
                "both independently finalized transfers close their obligations");
            equal(restarted.runtime.paymentService.countOpenObligations(roomId),0,
                "wallet becomes eligible only after the winner AND owner are paid");
            paymentRuntimeShutdown(restarted.runtime);
            const completed=buildRuntime(t.root,t.catalogPath);
            equal(completed.runtime.walletPool.getReservationForRoom(roomId),null,
                "fully settled prize wallet can finally be recycled on restart");
            paymentRuntimeShutdown(completed.runtime);
        } finally {t.cleanup();}
    });

    await section("restart reconstructs refund obligations without duplication", () => {
        const t = makeTemp();
        try {
            const dataDir = join(t.root, "payment-data");
            const first = buildRuntime(t.root, t.catalogPath, { paymentDataDirName: "payment-data" });
            const logger = { info() {}, warn() {}, error() {}, decisionTrace() {} };
            const eventBus = new EventBus({ logger, eventBusConfig: { logEvents: false, showDebugPanel: false } });
            eventBus.initialize();
            const roomManager = new RoomManager({ logger, eventBus, roomConfig: { maxPlayers: 3 } });
            roomManager.initialize();
            roomManager.attachSetupSessionLifecycle({ createForRoom: () => ({}), abortForRoom() {} });
            bindPaymentRuntimeToApplication(first.runtime, { roomManager, logger });
            const room = roomManager.createRoom();
            seedRoomPayments(first.runtime, room.roomId, 2);
            roomManager.destroyRoom(room.roomId);
            equal(first.runtime.refundStore.size, 2, "two confirmed payments -> two obligations");
            const idsBefore = first.runtime.refundStore.list().map((o) => o.obligationId).sort();
            paymentRuntimeShutdown(first.runtime);
            managerShutdown(roomManager, eventBus);

            const restartInit = buildPaymentRuntime({
                dataDir, network: "testnet", walletCatalogPath: t.catalogPath,
                nowProvider: () => NOW_MS, logger: null,
                fetchImpl: async () => ({ status: 200, json: async () => ({ transactions: [], address_book: {} }) }),
                apiKeyProvider: () => SYNTHETIC_API_KEY,
                settlementEvidenceProvider: new SyntheticTonSettlementEvidenceProvider({ nowProvider: () => NOW_MS })
            });
            const recovery = restartInit.initialize();
            equal(restartInit.refundStore.size, 2, "restart reloads obligations without duplicating them");
            check(restartInit.walletPool.getReservationForRoom(room.roomId)!==null,
                "restart must retain the old room wallet until BOTH confirmed players receive refunds");
            assert.deepEqual(restartInit.refundStore.list().map((o) => o.obligationId).sort(), idsBefore,
                "restart preserves exact obligation identities");
            equal(recovery.refundRecovery.length, 2, "restart recovery reports each outstanding obligation");
            for (const item of recovery.refundRecovery) {
                equal(item.outcome, "PENDING_EXECUTION_DISABLED", "obligations remain recoverable pending a signer");
            }

            // A repeated close callback is an idempotent replay, not a new obligation.
            const replay = restartInit.refundLifecycle.prepareClosedRoom({
                roomId: room.roomId, roomNumber: room.roomNumber, closureReason: "unspecified", status: "DESTROYED"
            });
            equal(replay.length, 2, "repeated close returns both existing obligations");
            equal(restartInit.refundStore.size, 2, "repeated close creates no duplicate obligation");
            paymentRuntimeShutdown(restartInit);
        } finally { t.cleanup(); }
    });

    await section("room number, TESTNET and global ID -3 survive restart and conflicts fail closed", () => {
        const t = makeTemp();
        try {
            const dataDir = join(t.root, "payment-data");
            const first = buildRuntime(t.root, t.catalogPath, { paymentDataDirName: "payment-data" });
            const logger = { info() {}, warn() {}, error() {}, decisionTrace() {} };
            const eventBus = new EventBus({ logger, eventBusConfig: { logEvents: false, showDebugPanel: false } });
            eventBus.initialize();
            const roomManager = new RoomManager({ logger, eventBus, roomConfig: { maxPlayers: 3 } });
            roomManager.initialize();
            roomManager.attachSetupSessionLifecycle({ createForRoom: () => ({}), abortForRoom() {} });
            bindPaymentRuntimeToApplication(first.runtime, { roomManager, logger });
            const room = roomManager.createRoom();
            const roomNumber = room.roomNumber;
            seedRoomPayments(first.runtime, room.roomId, 1);
            roomManager.destroyRoom(room.roomId);
            const closedRoom = first.runtime.refundStore.getClosedRoom(room.roomId);
            equal(closedRoom.roomNumber, roomNumber, "closed-room snapshot keeps the public room number");
            equal(closedRoom.networkName, "TESTNET", "closed-room snapshot keeps TESTNET");
            equal(closedRoom.globalId, -3, "closed-room snapshot keeps global ID -3");
            const obligation = first.runtime.refundStore.list()[0];
            equal(obligation.networkName, "TESTNET", "obligation keeps TESTNET across close");
            equal(obligation.globalId, -3, "obligation keeps global ID -3 across close");
            equal(obligation.intentNetwork, undefined, "obligation does not duplicate a second network field");
            const intent = first.runtime.intentStore.require("payment_seed_0");
            equal(intent.network, "testnet", "the payment intent keeps lowercase testnet");

            paymentRuntimeShutdown(first.runtime);
            managerShutdown(roomManager, eventBus);

            // Conflicting network identities are rejected, never relabeled.
            throws(() => RefundObligation.fromRecord({ ...obligation.toRecord(), globalId: -239 }),
                /globalId must be -3/, "a Testnet obligation relabeled with a Mainnet global ID is rejected");
            throws(() => first.runtime.refundStore.recordClosedRoom({
                roomId: room.roomId, roomNumber, closureReason: "setup_expired",
                closedAtMs: NOW_MS, networkName: "MAINNET", globalId: -3
            }), /Testnet identity/, "a MAINNET closed-room refund context is rejected in durable storage");

            const restart = buildPaymentRuntime({
                dataDir, network: "testnet", walletCatalogPath: t.catalogPath,
                nowProvider: () => NOW_MS, logger: null,
                fetchImpl: async () => ({ status: 200, json: async () => ({ transactions: [], address_book: {} }) }),
                apiKeyProvider: () => SYNTHETIC_API_KEY,
                settlementEvidenceProvider: new SyntheticTonSettlementEvidenceProvider({ nowProvider: () => NOW_MS })
            });
            restart.initialize();
            equal(restart.refundStore.getClosedRoom(room.roomId).globalId, -3, "closed-room identity restored on restart");
            equal(restart.refundStore.list()[0].globalId, -3, "obligation global ID -3 restored on restart");
            paymentRuntimeShutdown(restart);
        } finally { t.cleanup(); }
    });

    await section("outgoing refund cannot complete without validated persisted finalized evidence", async () => {
        const t = makeTemp();
        try {
            const { runtime } = buildRuntime(t.root, t.catalogPath);
            const record = buildPendingObligation(runtime, "attempt-room", 5);
            equal(record.state, REFUND_STATE.PENDING, "obligation starts PENDING");

            // Mark the submission start; completion is still structurally impossible.
            const updated = runtime.refundStore.update({
                ...record.toRecord(), state: REFUND_STATE.SUBMISSION_UNKNOWN,
                attempts: [{
                    networkName: "TESTNET", globalId: -3, idempotencyKey: record.idempotencyKey,
                    attemptId: "attempt-1", state: "SUBMISSION_UNKNOWN", startedAtMs: NOW_MS
                }]
            });
            equal(updated.state, REFUND_STATE.SUBMISSION_UNKNOWN, "obligation can record an ambiguous submission start");
            throws(() => runtime.refundStore.update({
                ...updated.toRecord(), state: REFUND_STATE.COMPLETE
            }), /cannot be complete|submission and completion are disabled/,
                "completion without evidence is rejected by the store");

            const provider = new TestnetRefundProvider({ globalId: -3 });
            await rejects(provider.submitRefund(), /execution is disabled/,
                "there is no authorized outgoing Testnet submitter");
            throws(() => new TestnetRefundProvider({ globalId: -239 }), /global ID -3/,
                "a Mainnet outgoing provider cannot be constructed");
            equal(runtime.getCapabilities().outgoingRefundTransfersEnabled, false,
                "capability descriptor keeps outgoing refunds disabled");

            paymentRuntimeShutdown(runtime);
        } finally { t.cleanup(); }
    });

    await section("a critical initialization failure leaves payments disabled and fails closed", () => {
        const t = makeTemp();
        try {
            const logger = { info() {}, warn() {}, error() {}, decisionTrace() {} };
            const eventBus = new EventBus({ logger, eventBusConfig: { logEvents: false, showDebugPanel: false } });
            eventBus.initialize();
            const roomManager = new RoomManager({ logger, eventBus, roomConfig: { maxPlayers: 3 } });
            roomManager.initialize();
            roomManager.attachSetupSessionLifecycle({ createForRoom: () => ({}), abortForRoom() {} });

            // Build a runtime but corrupt its durable intent store so initialize()
            // throws, mirroring a real storage/provider failure at startup.
            const dataDir = join(t.root, "payment-data");
            const runtime = buildPaymentRuntime({
                dataDir, network: "testnet", walletCatalogPath: t.catalogPath,
                nowProvider: () => NOW_MS, logger: null,
                fetchImpl: async () => ({ status: 200, json: async () => ({ transactions: [], address_book: {} }) }),
                apiKeyProvider: () => SYNTHETIC_API_KEY,
                settlementEvidenceProvider: new SyntheticTonSettlementEvidenceProvider({ nowProvider: () => NOW_MS })
            });
            mkdirSync(join(runtime.networkDataDir, "payment-intents"), { recursive: true });
            writeFileSync(join(runtime.networkDataDir, "payment-intents", "corrupt.json"), "{ not valid json", "utf8");

            // Simulate the app.js fail-closed try/catch.
            let ready = false;
            let gate = null;
            try {
                runtime.initialize();
                ready = true;
                gate = runtime.paymentGate;
                bindPaymentRuntimeToApplication(runtime, { roomManager, logger });
            } catch {
                ready = false;
                gate = null;
            }
            check(!ready, "a corrupt store leaves the payment runtime uninitialized");
            check(!roomManager._refundLifecycle, "no broken refund lifecycle is attached on failure");

            // GameStartAuthorization with no gate must deny every start.
            const authz = makeAuthorization(gate, {
                status: ROOM_STATUS.FULL, maxPlayers: 3, players: ["a", "b", "c"]
            });
            authz.eventBus.fire(EVENT_TYPES.VERIFY_BARRIER_COMPLETED, { roomId: "room-fail-closed" });
            equal(authz.authorizedCount(), 0, "a missing payment gate cannot authorize gameplay");
            authz.authorization.shutdown();
            managerShutdown(roomManager, eventBus);
        } finally { t.cleanup(); }
    });

    process.stdout.write(`PASS room wallet payment runtime integration | assertions=${assertions} | sections=${sections}\n`);
}

function paymentRuntimeShutdown(runtime) {
    try { runtime.shutdown(); } catch { /* best effort */ }
}

function managerShutdown(roomManager, eventBus) {
    try { roomManager.shutdown(); } catch { /* best effort */ }
    try { eventBus.shutdown(); } catch { /* best effort */ }
}

/**
 * Seed `confirmed` of three authoritative settled payments for a room directly
 * into the runtime's durable intent + ledger stores (proven refund-test recipe).
 *
 * Unless `keepUnconfirmedPending` is set, unconfirmed requirements are left in
 * a terminal FAILED state, which is the realistic post-setup-expiry condition
 * (and leaves no open wallet obligation for restart reconciliation to trip on).
 */
function seedRoomPayments(runtime, roomId, confirmed, prefix = "payment_seed", { keepUnconfirmedPending = false } = {}) {
    // The old synthetic test used a nonexistent "wallet-testnet" destination.
    // A wallet with real confirmed principal must always be traceable to a
    // genuine reserved slot among the 64 public Testnet room wallets.
    const wallet = runtime.paymentService.getWalletForRoom(roomId)
        ?? runtime.paymentService.reserveWalletForRoom({roomId,network:"testnet"});
    for (let index = 0; index < 3; index += 1) {
        const paymentReference = `${prefix}_${index}`;
        const intent = new PaymentIntent({
            paymentReference,
            roomId,
            playerId: `seed-player-${index}`,
            network: "testnet",
            destinationWalletId: wallet.walletId,
            destinationWalletAddress: wallet.address,
            expectedSender: TESTNET_PAYER,
            amountAtomic: 1_000_000_000,
            asset: "TON",
            createdAt: NOW_MS - 1000,
            expiresAt: NOW_MS + 1000,
            roomDeadlineMs: NOW_MS + 2000
        });
        runtime.intentStore.save(intent);
        if (index < confirmed) {
            settleSeed(runtime, roomId, index, `incoming_${index}`, prefix, intent);
        } else if (!keepUnconfirmedPending) {
            runtime.intentStore.update(intent.transition(PAYMENT_INTENT_STATE.FAILED, { now: NOW_MS }));
        }
    }
}

function settleSeed(runtime, roomId, index, transactionId, prefix = "payment_seed", existingIntent = null) {
    const paymentReference = `${prefix}_${index}`;
    const intent = existingIntent ?? runtime.intentStore.require(paymentReference);
    const matched = intent.transition(PAYMENT_INTENT_STATE.MATCHED, { transactionId, now: NOW_MS });
    runtime.intentStore.update(matched);
    runtime.intentStore.update(matched.transition(PAYMENT_INTENT_STATE.SETTLED, { now: NOW_MS }));
    runtime.ledgerStore.append({
        idempotencyKey: `principal:${paymentReference}:${transactionId}`,
        roomId,
        kind: LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL,
        amountAtomic: intent.amountAtomic,
        playerId: intent.playerId,
        asset: intent.asset,
        network: intent.network,
        metadata: { paymentReference, transactionId, intentState: "SETTLED", source: "SETTLED_PAYMENT_INTENT" }
    });
}

function buildPendingObligation(runtime, roomId, roomNumber) {
    const obligation = RefundObligation.fromRecord({
        schemaVersion: 1,
        obligationId: "rfd_seed_attempt",
        idempotencyKey: "TESTNET:WW-SEED:incoming_seed",
        networkName: "TESTNET",
        globalId: -3,
        roomNumber,
        roomId,
        playerId: "seed-player",
        paymentIntentId: "WW-SEED",
        incomingTransactionId: "incoming_seed",
        amountAtomic: 1_000_000_000,
        denomination: "TON",
        payerAddress: TESTNET_PAYER,
        refundDestination: TESTNET_PAYER,
        closureReason: "setup_expired",
        createdAtMs: NOW_MS,
        state: REFUND_STATE.PENDING,
        attempts: [],
        outgoingTransactionId: null,
        finalizedEvidence: null,
        lastError: null
    });
    return runtime.refundStore.create(obligation).obligation;
}

run().then(() => {
    // Give any stray finality timers a beat to avoid dangling handles.
    setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref?.();
}, (error) => {
    process.stderr.write(`Payment runtime integration FAILED: ${error?.stack ?? error}\n`);
    process.exit(1);
});
