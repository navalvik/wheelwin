/**
 * T2.6 — WalletManager and SessionWalletStore tests.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { SessionWalletStore } from "../session/SessionWalletStore.js";
import { WalletManager } from "../session/WalletManager.js";
import {
    WalletAlreadyExistsError,
    WalletNetworkMismatchError,
    WalletSessionConflictError,
    WalletSessionExpiredError,
    WalletValidationError
} from "../session/WalletManagerErrors.js";
import { WALLET_SESSION_STATUS } from "../session/WalletSessionStates.js";

function friendlyAddress(seedLabel) {

    const seed = createHash("sha256").update(seedLabel).digest();

    const keyPair = keyPairFromSeed(seed);

    return WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    }).address.toString({
        bounceable: true,
        urlSafe: true
    });

}

function createLogger() {

    return {
        info() {},
        warn() {},
        error() {},
        debug() {}
    };

}

function createHarness({
    dataDir = null,
    defaultNetwork = "testnet",
    tonService = null
} = {}) {

    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const persistence = dataDir
        ? (() => {

            const store = new TonFinancialPersistence({ dataDir });

            store.initialize();

            return store;

        })()
        : null;

    const sessionWalletStore = new SessionWalletStore({
        financialPersistence: persistence,
        logger
    });

    const manager = new WalletManager({
        logger,
        eventBus,
        tonService,
        sessionWalletStore,
        financialPersistence: persistence,
        defaultNetwork
    });

    manager.initialize();

    return {
        manager,
        sessionWalletStore,
        persistence,
        eventBus
    };

}

async function main() {

    const walletA = friendlyAddress("wallet-player-a");

    const walletB = friendlyAddress("wallet-player-b");

    const walletC = friendlyAddress("wallet-player-c");

    // --- create + connect + verify ---

    {
        const { manager, eventBus } = createHarness();

        const events = [];

        eventBus.subscribe(EVENT_TYPES.WALLET_SESSION_CREATED, (event) => {

            events.push(event.type);

        });

        eventBus.subscribe(EVENT_TYPES.WALLET_CONNECTED, (event) => {

            events.push(event.type);

        });

        eventBus.subscribe(EVENT_TYPES.WALLET_VERIFIED, (event) => {

            events.push(event.type);

        });

        const session = await manager.connectWallet({
            playerId: "p1",
            roomId: "room-1",
            walletAddress: walletA,
            network: "testnet"
        });

        assert.equal(session.status, WALLET_SESSION_STATUS.CONNECTED);

        assert.equal(session.walletAddress, walletA);

        const verified = await manager.verifyWallet({
            walletSessionId: session.walletSessionId
        });

        assert.equal(verified.status, WALLET_SESSION_STATUS.VERIFIED);

        assert.ok(events.includes(EVENT_TYPES.WALLET_SESSION_CREATED));

        assert.ok(events.includes(EVENT_TYPES.WALLET_CONNECTED));

        assert.ok(events.includes(EVENT_TYPES.WALLET_VERIFIED));

        console.log("  create + connect + verify: OK");
    }

    // --- register wallet session ---

    {
        const { manager } = createHarness();

        const session = await manager.registerWallet({
            playerId: "p1",
            roomId: "room-1",
            network: "testnet"
        });

        assert.equal(session.status, WALLET_SESSION_STATUS.CREATED);

        assert.equal(session.walletAddress, null);

        console.log("  register wallet session: OK");
    }

    // --- invalid address ---

    {
        const { manager } = createHarness();

        await assert.rejects(
            () => manager.connectWallet({
                playerId: "p1",
                roomId: "room-1",
                walletAddress: "not-a-wallet",
                network: "testnet"
            }),
            (error) => error instanceof WalletValidationError
        );

        console.log("  invalid address: OK");
    }

    // --- wrong network ---

    {
        const tonService = {
            getActiveNetwork() {

                return "mainnet";

            },
            isConnected() {

                return true;

            }
        };

        const { manager } = createHarness({
            defaultNetwork: "mainnet",
            tonService
        });

        await assert.rejects(
            () => manager.connectWallet({
                playerId: "p1",
                roomId: "room-1",
                walletAddress: walletA,
                network: "testnet"
            }),
            (error) => error instanceof WalletNetworkMismatchError
        );

        console.log("  wrong network: OK");
    }

    // --- duplicate register ---

    {
        const { manager } = createHarness();

        await manager.registerWallet({
            playerId: "p1",
            roomId: "room-1",
            network: "testnet"
        });

        await assert.rejects(
            () => manager.registerWallet({
                playerId: "p1",
                roomId: "room-1",
                network: "testnet"
            }),
            (error) => error instanceof WalletAlreadyExistsError
        );

        console.log("  duplicate register: OK");
    }

    // --- duplicate wallet address across players ---

    {
        const { manager } = createHarness();

        await manager.connectWallet({
            playerId: "p1",
            roomId: "room-1",
            walletAddress: walletA,
            network: "testnet"
        });

        await assert.rejects(
            () => manager.connectWallet({
                playerId: "p2",
                roomId: "room-1",
                walletAddress: walletA,
                network: "testnet"
            }),
            (error) => error instanceof WalletSessionConflictError
        );

        console.log("  duplicate wallet address: OK");
    }

    // --- reconnect without duplicate session ---

    {
        const { manager } = createHarness();

        const first = await manager.connectWallet({
            playerId: "p1",
            roomId: "room-1",
            walletAddress: walletA,
            network: "testnet"
        });

        await manager.disconnectWallet(first.walletSessionId);

        const reconnected = await manager.connectWallet({
            playerId: "p1",
            roomId: "room-1",
            walletAddress: walletA,
            network: "testnet"
        });

        assert.equal(reconnected.walletSessionId, first.walletSessionId);

        assert.equal(reconnected.status, WALLET_SESSION_STATUS.CONNECTED);

        console.log("  reconnect: OK");
    }

    // --- disconnect ---

    {
        const { manager, eventBus } = createHarness();

        let disconnected = false;

        eventBus.subscribe(EVENT_TYPES.WALLET_DISCONNECTED, () => {

            disconnected = true;

        });

        const session = await manager.connectWallet({
            playerId: "p1",
            roomId: "room-1",
            walletAddress: walletA,
            network: "testnet"
        });

        const result = await manager.disconnectWallet(session.walletSessionId);

        assert.equal(result.status, WALLET_SESSION_STATUS.DISCONNECTED);

        assert.equal(disconnected, true);

        console.log("  disconnect: OK");
    }

    // --- expiration ---

    {
        const { manager, sessionWalletStore } = createHarness();

        const session = await manager.connectWallet({
            playerId: "p1",
            roomId: "room-1",
            walletAddress: walletA,
            network: "testnet"
        });

        sessionWalletStore.update(session.walletSessionId, {
            expiresAt: Date.now() - 1000
        });

        await assert.rejects(
            () => manager.connectWallet({
                playerId: "p1",
                roomId: "room-1",
                walletAddress: walletA,
                network: "testnet"
            }),
            (error) => error instanceof WalletSessionExpiredError
        );

        const expired = await manager.expireWallet(session.walletSessionId);

        assert.equal(expired.status, WALLET_SESSION_STATUS.EXPIRED);

        console.log("  expiration: OK");
    }

    // --- revocation ---

    {
        const { manager } = createHarness();

        const session = await manager.connectWallet({
            playerId: "p1",
            roomId: "room-1",
            walletAddress: walletA,
            network: "testnet"
        });

        const revoked = await manager.revokeWallet(session.walletSessionId, {
            reason: "manual_revoke"
        });

        assert.equal(revoked.status, WALLET_SESSION_STATUS.REVOKED);

        assert.equal(manager.getWallet(session.walletSessionId).status, WALLET_SESSION_STATUS.REVOKED);

        console.log("  revocation: OK");
    }

    // --- verified wallet cannot be replaced ---

    {
        const { manager } = createHarness();

        const session = await manager.connectWallet({
            playerId: "p1",
            roomId: "room-1",
            walletAddress: walletA,
            network: "testnet"
        });

        await manager.verifyWallet({ walletSessionId: session.walletSessionId });

        await assert.rejects(
            () => manager.connectWallet({
                playerId: "p1",
                roomId: "room-1",
                walletAddress: walletB,
                network: "testnet"
            }),
            (error) => error instanceof WalletSessionConflictError
        );

        console.log("  verified wallet replacement blocked: OK");
    }

    // --- wallet change before verification ---

    {
        const { manager, eventBus } = createHarness();

        let changed = false;

        eventBus.subscribe(EVENT_TYPES.WALLET_CHANGED, () => {

            changed = true;

        });

        const session = await manager.connectWallet({
            playerId: "p1",
            roomId: "room-1",
            walletAddress: walletA,
            network: "testnet"
        });

        const updated = await manager.connectWallet({
            playerId: "p1",
            roomId: "room-1",
            walletAddress: walletB,
            network: "testnet"
        });

        assert.equal(updated.walletSessionId, session.walletSessionId);

        assert.equal(updated.walletAddress, walletB);

        assert.equal(changed, true);

        console.log("  wallet change before verification: OK");
    }

    // --- persistence + restore after restart ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-wallet-"));

        const first = createHarness({ dataDir });

        const session = await first.manager.connectWallet({
            playerId: "p1",
            roomId: "room-1",
            gameId: "game-1",
            walletAddress: walletA,
            network: "testnet"
        });

        await first.manager.verifyWallet({ walletSessionId: session.walletSessionId });

        first.persistence.shutdown();

        const second = createHarness({ dataDir });

        const summary = second.manager.restoreSessions();

        assert.equal(summary.restored, 1);

        const restored = second.manager.getWalletByPlayer("p1", "room-1");

        assert.ok(restored);

        assert.equal(restored.walletSessionId, session.walletSessionId);

        assert.equal(restored.status, WALLET_SESSION_STATUS.VERIFIED);

        assert.equal(restored.walletAddress, walletA);

        TonFinancialPersistence.destroyStorage(dataDir);

        console.log("  persistence + restore: OK");
    }

    // --- SessionWalletStore legacy API ---

    {
        const { sessionWalletStore } = createHarness();

        assert.equal(sessionWalletStore.getWallet("room-legacy", "p1"), null);

        sessionWalletStore.setWallet("room-legacy", "p1", walletC);

        assert.equal(sessionWalletStore.getWallet("room-legacy", "p1"), walletC);

        assert.deepEqual(sessionWalletStore.getRoomWallets("room-legacy"), {
            p1: walletC
        });

        sessionWalletStore.clearRoom("room-legacy");

        assert.equal(sessionWalletStore.getWallet("room-legacy", "p1"), null);

        console.log("  legacy SessionWalletStore API: OK");
    }

    // --- lookup helpers + health ---

    {
        const { manager } = createHarness();

        const session = await manager.connectWallet({
            playerId: "p1",
            roomId: "room-health",
            walletAddress: walletA,
            network: "testnet"
        });

        await manager.verifyWallet({ walletSessionId: session.walletSessionId });

        assert.equal(manager.getWallet(session.walletSessionId).playerId, "p1");

        assert.equal(manager.getWalletByPlayer("p1", "room-health").walletSessionId, session.walletSessionId);

        assert.equal(manager.getWalletByRoom("room-health").length, 1);

        const health = manager.health();

        assert.equal(health.activeSessions, 1);

        assert.equal(health.verifiedWallets, 1);

        assert.equal(health.network, "testnet");

        const dashboard = manager.getDashboardSnapshot("room-health");

        assert.equal(dashboard.sessions.length, 1);

        assert.equal(dashboard.sessions[0].status, WALLET_SESSION_STATUS.VERIFIED);

        console.log("  lookup + health + dashboard: OK");
    }

    console.log("walletManager.test.js: all assertions passed");

}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
