import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ROOM_LIFETIME_MS, ROOM_WALLET_POOL_SIZE } from "../../payment/RoomPaymentConstants.js";
import { PAYMENT_INTENT_STATE } from "../../payment/PaymentIntentStatus.js";
import { LEDGER_ENTRY_KIND } from "../../payment/ledger/LedgerConstants.js";
import { PaymentExecutionBlockedError } from "../../payment/PaymentErrors.js";
import {
    LIVE_PAYMENT_ACCEPTANCE_ENABLED
} from "../../payment/PaymentLifecycleAvailability.js";
import { buildPaymentRuntime } from "../../payment/runtime/PaymentRuntimeFactory.js";
import { bindPaymentRuntimeToApplication } from "../../payment/runtime/PaymentApplicationBinder.js";
import {
    DESCRIPTOR_STAKE_RELATION
} from "../../payment/runtime/RoomPaymentSessionAdapter.js";
import { SyntheticTonSettlementEvidenceProvider } from "../helpers/syntheticTonSettlementEvidence.js";

const BASE_MS = 1_700_100_000_000;
const CREATED_AT = BASE_MS;
const NOW_MS = BASE_MS + 5_000;
const TRANSFER_SECONDS = Math.floor(NOW_MS / 1_000);
const SYNTHETIC_API_KEY = "SYNTHETIC-TONCENTER-TEST-KEY-NOT-REAL";
const TESTNET_PAYER = `0:${"a".repeat(64)}`;

let assertions = 0;
let sections = 0;
const TOTAL_SECTIONS = 5;

function check(value, message) { assert.ok(value, message); assertions += 1; }
function equal(actual, expected, message) { assert.equal(actual, expected, message); assertions += 1; }
function throws(fn, errorClass, message) { assert.throws(fn, errorClass, message); assertions += 1; }
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
    const hash = createHash("sha256").update(`payment-binder:${seed}`).digest();
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
    const root = mkdtempSync(join(tmpdir(), "wheelwin-payment-binder-"));
    return { root, catalogPath: writeCatalog(root), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function buildRuntime(root, catalogPath, { now = () => NOW_MS } = {}) {
    const state = { payload: { transactions: [], address_book: {} } };
    const evidence = new SyntheticTonSettlementEvidenceProvider({ nowProvider: now });
    const runtime = buildPaymentRuntime({
        dataDir: join(root, "payment-data"),
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

function emptyPayload(...transactions) {
    return { transactions, address_book: {} };
}

function threePlayerDescriptor(roomId, amounts = [1, 2, 3]) {
    const requiredPlayers = [0, 1, 2].map((index) => ({
        roomId,
        paymentReference: `WW-BINDER-PLAYER-${index}`,
        playerId: `binder-player-${index}`,
        expectedSender: syntheticAddress(`binder-sender-${index}`),
        amountAtomic: amounts[index] * 1_000_000_000
    }));
    return { roomId, roomCreatedAt: CREATED_AT, network: "testnet", asset: "TON", stakeLedgerRelation: DESCRIPTOR_STAKE_RELATION, requiredPlayers };
}

function minimalRoomManager(roomId, roomCreatedAt, playerIds) {
    const room = { roomId, createdAt: roomCreatedAt, status: "ACTIVE", players: [...playerIds] };
    return {
        getRoom: (id) => (id === roomId ? room : null),
        attachRefundLifecycle: () => {}
    };
}

async function run() {
    await section("production default binder keeps preparation disabled (no env override, no global flip)", async () => {
        const t = makeTemp();
        try {
            const { runtime } = buildRuntime(t.root, t.catalogPath);
            const roomId = "room-binder-disabled";
            const playerIds = ["binder-player-0", "binder-player-1", "binder-player-2"];
            const roomManager = minimalRoomManager(roomId, CREATED_AT, playerIds);
            const gameStartAuthorization = { configurePaymentGate: () => {} };
            const binding = bindPaymentRuntimeToApplication(runtime, { roomManager, gameStartAuthorization, logger: null });

            // No paymentAcceptanceEnabled => resolves to LIVE_PAYMENT_ACCEPTANCE_ENABLED (false).
            assert.equal(LIVE_PAYMENT_ACCEPTANCE_ENABLED, false, "production default stays disabled");
            const descriptor = threePlayerDescriptor(roomId);
            throws(
                () => binding.prepareRoomPaymentSession(roomId, descriptor.requiredPlayers),
                PaymentExecutionBlockedError,
                "production-default binder rejects room payment session preparation"
            );
            equal(runtime.paymentService.listPaymentIntentsForRoom(roomId).length, 0,
                "disabled binder creates no payment intents");
            equal(runtime.paymentService.getWalletForRoom(roomId), null,
                "disabled binder reserves no room wallet");
            equal(runtime.ledger.store.listForRoom(roomId).filter(
                (entry) => entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
            ).length, 0, "disabled binder writes no stake records");
            paymentRuntimeShutdown(runtime);
        } finally { t.cleanup(); }
    });

    await section("test-only paymentAcceptanceEnabled binder prepares an authoritative room payment session", async () => {
        const t = makeTemp();
        try {
            const { runtime } = buildRuntime(t.root, t.catalogPath);
            const roomId = "room-binder-enabled";
            const playerIds = ["binder-player-0", "binder-player-1", "binder-player-2"];
            const roomManager = minimalRoomManager(roomId, CREATED_AT, playerIds);
            const gameStartAuthorization = { configurePaymentGate: () => {} };
            const binding = bindPaymentRuntimeToApplication(runtime, {
                roomManager, gameStartAuthorization, logger: null,
                // Test-only, explicit, per-binding-instance opt-in. Production app.js never passes this.
                paymentAcceptanceEnabled: true
            });

            const descriptor = threePlayerDescriptor(roomId);
            const prepared = binding.prepareRoomPaymentSession(roomId, descriptor.requiredPlayers);

            check(Object.isFrozen(prepared), "prepared session is immutable");
            equal(prepared.roomId, roomId, "session binds to the room");
            equal(prepared.network, "testnet", "session records TESTNET");
            equal(prepared.asset, "TON", "session records TON");
            equal(prepared.payments.length, 3, "one prepared payment per required player");

            const expectedReferences = descriptor.requiredPlayers.map((p) => p.paymentReference).sort();
            const actualReferences = prepared.payments.map((p) => p.paymentReference).sort();
            deepEqual(actualReferences, expectedReferences, "session carries the authoritative payment references");

            for (const payment of prepared.payments) {
                equal(payment.state, PAYMENT_INTENT_STATE.PENDING, "preparation marks intents PENDING (no settlement claimed)");
                equal(payment.asset, "TON", "intent asset is TON");
                equal(payment.network, "testnet", "intent network is testnet");
                const intent = runtime.paymentService.getPaymentIntent(payment.paymentReference);
                check(Boolean(intent), `intent persisted for ${payment.paymentReference}`);
                equal(intent.state, PAYMENT_INTENT_STATE.PENDING, "persisted intent is PENDING");
                equal(intent.amountAtomic, payment.amountAtomic, "persisted amount matches the descriptor");
                equal(intent.roomDeadlineMs, CREATED_AT + ROOM_LIFETIME_MS, "intent carries the immutable room deadline");
            }

            // Every persisted intent mirrors the authoritative descriptor exactly.
            const senderByReference = new Map(descriptor.requiredPlayers.map((p) => [p.paymentReference, p.expectedSender]));
            const playerByReference = new Map(descriptor.requiredPlayers.map((p) => [p.paymentReference, p.playerId]));
            const amountByReference = new Map(descriptor.requiredPlayers.map((p) => [p.paymentReference, p.amountAtomic]));
            for (const payment of prepared.payments) {
                const intent = runtime.paymentService.getPaymentIntent(payment.paymentReference);
                equal(intent.expectedSender, senderByReference.get(payment.paymentReference),
                    `persisted sender matches the descriptor for ${payment.paymentReference}`);
                equal(intent.playerId, playerByReference.get(payment.paymentReference),
                    `persisted player matches the descriptor for ${payment.paymentReference}`);
                equal(intent.amountAtomic, amountByReference.get(payment.paymentReference),
                    `persisted amount matches the descriptor for ${payment.paymentReference}`);
            }

            // Exactly one room wallet reserved and canonically assigned to every intent.
            const reservation = runtime.paymentService.getWalletForRoom(roomId);
            check(Boolean(reservation), "binder preparation reserves exactly one room wallet");
            equal(reservation.network, "testnet", "reserved wallet is a testnet wallet");
            for (const payment of prepared.payments) {
                const intent = runtime.paymentService.getPaymentIntent(payment.paymentReference);
                equal(intent.destinationWalletId, reservation.walletId, "intent uses the assigned wallet id");
                equal(intent.destinationWalletAddress, reservation.address, "intent uses the assigned wallet address");
            }
            equal(runtime.paymentService.listPaymentIntentsForRoom(roomId).length, 3, "three durable intents created");

            // One PLAYER_STAKE ledger record per payment; no INCOMING_PRINCIPAL (preparation never claims receipt).
            const stakes = runtime.ledger.store.listForRoom(roomId).filter(
                (entry) => entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
            );
            equal(stakes.length, 3, "one stake per required payment");
            for (const payment of prepared.payments) {
                const stake = stakes.find((entry) => entry.metadata?.paymentReference === payment.paymentReference);
                check(Boolean(stake), `stake recorded for ${payment.paymentReference}`);
                equal(stake.playerId, payment.playerId, "stake player matches the requirement");
                equal(stake.amountAtomic, payment.amountAtomic, "stake amount matches the requirement");
            }
            equal(runtime.ledger.store.listForRoom(roomId).filter(
                (entry) => entry.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL
            ).length, 0, "preparation records no principal (no receipt claimed)");

            // Preparation alone does not authorize gameplay (Step 4).
            const gateStatus = runtime.sessionAdapter.getGameStartGateStatus(roomId, playerIds);
            equal(gateStatus.eligible, false, "prepared-but-unpaid room fails the three-player gate");
            equal(gateStatus.reason, "required_payment_not_settled_unambiguously", "gate reports unsettled payments");

            paymentRuntimeShutdown(runtime);
        } finally { t.cleanup(); }
    });

    await section("test-only binder preparation is idempotent and creates no duplicates", async () => {
        const t = makeTemp();
        try {
            const { runtime } = buildRuntime(t.root, t.catalogPath);
            const roomId = "room-binder-idempotent";
            const playerIds = ["binder-player-0", "binder-player-1", "binder-player-2"];
            const roomManager = minimalRoomManager(roomId, CREATED_AT, playerIds);
            const gameStartAuthorization = { configurePaymentGate: () => {} };
            const binding = bindPaymentRuntimeToApplication(runtime, {
                roomManager, gameStartAuthorization, logger: null, paymentAcceptanceEnabled: true
            });

            const descriptor = threePlayerDescriptor(roomId);
            const first = binding.prepareRoomPaymentSession(roomId, descriptor.requiredPlayers);
            const second = binding.prepareRoomPaymentSession(roomId, descriptor.requiredPlayers);
            deepEqual(second.payments.map((p) => p.paymentReference).sort(),
                first.payments.map((p) => p.paymentReference).sort(), "idempotent replay returns the same references");
            equal(runtime.paymentService.listPaymentIntentsForRoom(roomId).length, 3, "replay does not duplicate intents");
            const stakes = runtime.ledger.store.listForRoom(roomId).filter(
                (entry) => entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
            );
            equal(stakes.length, 3, "replay does not duplicate stake records");
            const reservation = runtime.paymentService.getWalletForRoom(roomId);
            for (const intent of runtime.paymentService.listPaymentIntentsForRoom(roomId)) {
                equal(intent.destinationWalletId, reservation.walletId, "replay preserves one canonical wallet assignment");
            }
            paymentRuntimeShutdown(runtime);
        } finally { t.cleanup(); }
    });

    await section("test-only binder rejects preparation for a missing room without writing", async () => {
        const t = makeTemp();
        try {
            const { runtime } = buildRuntime(t.root, t.catalogPath);
            const roomManager = minimalRoomManager("room-exists", CREATED_AT, ["a", "b", "c"]);
            const gameStartAuthorization = { configurePaymentGate: () => {} };
            const binding = bindPaymentRuntimeToApplication(runtime, {
                roomManager, gameStartAuthorization, logger: null, paymentAcceptanceEnabled: true
            });
            throws(
                () => binding.prepareRoomPaymentSession("room-missing", [{ playerId: "a", paymentReference: "WW-X", expectedSender: syntheticAddress("s"), amountAtomic: 1_000_000_000 }]),
                PaymentExecutionBlockedError,
                "binder rejects preparation for a missing room"
            );
            equal(runtime.paymentService.listPaymentIntentsForRoom("room-missing").length, 0,
                "rejected preparation creates no intents");
            equal(runtime.paymentService.getWalletForRoom("room-missing"), null,
                "rejected preparation reserves no wallet");
            equal(runtime.ledger.store.size, 0, "rejected preparation writes no ledger records");
            paymentRuntimeShutdown(runtime);
        } finally { t.cleanup(); }
    });

    await section("seam does not weaken production: app.js-style binding stays disabled", async () => {
        const t = makeTemp();
        try {
            const { runtime } = buildRuntime(t.root, t.catalogPath);
            const roomManager = minimalRoomManager("room-prod", CREATED_AT, ["a", "b", "c"]);
            const gameStartAuthorization = { configurePaymentGate: (gate) => {} };
            // Mirrors server/app.js: no paymentAcceptanceEnabled passed.
            const binding = bindPaymentRuntimeToApplication(runtime, { roomManager, gameStartAuthorization, logger: null });
            throws(
                () => binding.prepareRoomPaymentSession("room-prod", []),
                PaymentExecutionBlockedError,
                "app.js-style binding keeps preparation disabled"
            );
            equal(LIVE_PAYMENT_ACCEPTANCE_ENABLED, false, "module constant unchanged by the seam");
            paymentRuntimeShutdown(runtime);
        } finally { t.cleanup(); }
    });

    process.stdout.write(`PASS payment binder preparation (test-only seam) | assertions=${assertions} | sections=${sections}\n`);
}

function paymentRuntimeShutdown(runtime) {
    try { runtime.shutdown(); } catch { /* best effort */ }
}

function deepEqual(actual, expected, message) { assert.deepEqual(actual, expected, message); assertions += 1; }

run().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
});
