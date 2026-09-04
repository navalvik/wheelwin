import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConfigurationIssueCollector } from "../config/ConfigurationError.js";
import { validateSecrets } from "../config/validators/validateSecrets.js";
import {
    createRoomWalletRegistryFromEnv,
    loadRoomWalletRuntimeConfig
} from "../payment/roomWallet/RoomWalletRuntimeResolver.js";
import {
    assertOutputDirSafe,
    buildMasterBackup,
    buildRuntimePayload,
    generateRoomWalletIdentities,
    hashFileSha256,
    MASTER_BACKUP_FILENAME,
    RUNTIME_JSON_FILENAME,
    validateProvisionedCatalog,
    writeProvisionArtifacts
} from "../scripts/lib/provisionRoomWallets.js";
import {
    createDummyRoomWalletCatalog,
    createDummyRoomWalletEntry
} from "./helpers/dummyRoomWallet.js";

test("provisioner generates 64 sequential TESTNET WalletContractV4 identities", () => {
    const identities = generateRoomWalletIdentities();
    const stats = validateProvisionedCatalog(identities);

    assert.equal(stats.count, 64);
    assert.equal(stats.uniqueAddresses, 64);
    assert.equal(stats.uniquePublicKeys, 64);
    assert.equal(stats.uniqueSecretKeys, 64);
    assert.equal(stats.workchain, 0);
    assert.equal(stats.network, "testnet");
    assert.equal(stats.walletContractType, "WalletContractV4R2");
    assert.deepEqual(identities.map((entry) => entry.roomNumber), Array.from({ length: 64 }, (_, index) => index + 1));
    assert.equal(identities[0].publicKey.length, 64);
    assert.equal(identities[0].secretKey.length, 128);
    assert.match(identities[0].address, /^EQ[A-Za-z0-9_-]{46}$/);
});

test("provisioner does not copy dummy Room Wallet fixtures", () => {
    const identities = generateRoomWalletIdentities();
    const dummy = createDummyRoomWalletCatalog(64);
    const dummyAddresses = new Set(dummy.map((entry) => entry.address));
    const dummyPublicKeys = new Set(dummy.map((entry) => entry.publicKey));
    const dummySecretKeys = new Set(dummy.map((entry) => entry.secretKey));

    assert.equal(identities.filter((entry) => dummyAddresses.has(entry.address)).length, 0);
    assert.equal(identities.filter((entry) => dummyPublicKeys.has(entry.publicKey)).length, 0);
    assert.equal(identities.filter((entry) => dummySecretKeys.has(entry.secretKey)).length, 0);
    assert.notEqual(identities[16].address, createDummyRoomWalletEntry(17).address);
});

test("generated ROOM_WALLETS_JSON is accepted by the production parser and registry", () => {
    const identities = generateRoomWalletIdentities();
    const runtimePayload = buildRuntimePayload(identities);
    const env = {
        ROOM_WALLETS_JSON: JSON.stringify(runtimePayload),
        ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET",
        TON_NETWORK: "testnet"
    };

    const parsed = loadRoomWalletRuntimeConfig(env);
    const registry = createRoomWalletRegistryFromEnv(env);

    assert.equal(parsed.entries.length, 64);
    assert.equal(registry.size(), 64);

    for (let roomNumber = 1; roomNumber <= 64; roomNumber += 1) {
        assert.equal(registry.require(roomNumber).address, identities[roomNumber - 1].address);
        assert.equal(registry.require(roomNumber).network, "testnet");
        assert.equal(registry.require(roomNumber).publicKey, undefined);
        assert.equal(registry.require(roomNumber).secretKey, undefined);
    }

    const collector = new ConfigurationIssueCollector();
    validateSecrets(collector, {
        DEVELOPER_AUTH_ENABLED: "false",
        ...env
    }, {
        nodeEnv: "development",
        tonDeployMode: "stub",
        developer: { enabled: false, configured: false }
    });
    assert.equal(collector.size, 0);
});

test("provisioner rejects unsafe output directories and overwrites", async () => {
    assert.throws(
        () => assertOutputDirSafe("relative-dir", "G:\\WheelWin"),
        /absolute path/
    );
    assert.throws(
        () => assertOutputDirSafe("G:\\WheelWin\\secrets", "G:\\WheelWin"),
        /inside the Git repository/
    );

    const identities = generateRoomWalletIdentities();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ww-room-wallets-"));

    try {
        const first = await writeProvisionArtifacts(tempDir, {
            masterBackup: buildMasterBackup(identities),
            runtimePayload: buildRuntimePayload(identities)
        });

        assert.equal(path.basename(first.masterPath), MASTER_BACKUP_FILENAME);
        assert.equal(path.basename(first.runtimePath), RUNTIME_JSON_FILENAME);
        assert.match(first.masterSha256, /^[0-9a-f]{64}$/);
        assert.match(first.runtimeSha256, /^[0-9a-f]{64}$/);
        assert.equal(await hashFileSha256(first.masterPath), first.masterSha256);
        assert.equal(await hashFileSha256(first.runtimePath), first.runtimeSha256);

        const reread = JSON.parse(await readFile(first.runtimePath, "utf8"));
        const parsed = loadRoomWalletRuntimeConfig({
            ROOM_WALLETS_JSON: JSON.stringify(reread),
            ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET",
            TON_NETWORK: "testnet"
        });
        assert.equal(parsed.entries.length, 64);

        await assert.rejects(
            () => writeProvisionArtifacts(tempDir, {
                masterBackup: buildMasterBackup(identities),
                runtimePayload: buildRuntimePayload(identities)
            }),
            /refusing to overwrite/
        );
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test("provisioner rejects incomplete catalogs and non-testnet network", () => {
    assert.throws(
        () => generateRoomWalletIdentities({ count: 63 }),
        /exactly 64/
    );
    assert.throws(
        () => generateRoomWalletIdentities({ network: "mainnet" }),
        /TESTNET/
    );
});
