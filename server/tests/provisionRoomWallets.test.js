import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ConfigurationIssueCollector } from "../config/ConfigurationError.js";
import { validateSecrets } from "../config/validators/validateSecrets.js";
import {
    createRoomWalletRegistryFromEnv,
    loadRoomWalletRuntimeConfig
} from "../payment/roomWallet/RoomWalletRuntimeResolver.js";
import {
    MAINNET_MASTER_BACKUP_FILENAME,
    MAINNET_RUNTIME_JSON_FILENAME,
    MASTER_BACKUP_FILENAME,
    RESERVED_TESTNET_PROVISION_OUTPUT_DIR_BASENAME,
    RUNTIME_JSON_FILENAME,
    assertOutputDirSafe,
    buildMasterBackup,
    buildPublicSummary,
    buildRuntimePayload,
    formatPublicSummaryLines,
    generateRoomWalletIdentities,
    parseProvisionCliArgs,
    provisionArtifactFilenames,
    validateProvisionedCatalog,
    writeProvisionArtifacts
} from "../scripts/lib/provisionRoomWallets.js";
import {
    createDummyRoomWalletCatalog,
    createDummyRoomWalletEntry
} from "./helpers/dummyRoomWallet.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const provisionCli = path.join(repoRoot, "server", "scripts", "provision-room-wallets.mjs");

function assertCatalogShape(identities, network) {
    const stats = validateProvisionedCatalog(identities, { envNetwork: network });

    assert.equal(stats.count, 64);
    assert.equal(stats.uniqueAddresses, 64);
    assert.equal(stats.uniquePublicKeys, 64);
    assert.equal(stats.uniqueSecretKeys, 64);
    assert.equal(stats.workchain, 0);
    assert.equal(stats.network, network);
    assert.equal(stats.walletContractType, "WalletContractV4R2");
    assert.deepEqual(identities.map((entry) => entry.roomNumber), Array.from({ length: 64 }, (_, index) => index + 1));
    assert.ok(identities.every((entry) => entry.network === network));
    assert.equal(identities[0].publicKey.length, 64);
    assert.equal(identities[0].secretKey.length, 128);
    assert.match(identities[0].address, /^EQ[A-Za-z0-9_-]{46}$/);
}

function assertRuntimeAccepts(identities, network) {
    const env = {
        ROOM_WALLETS_JSON: JSON.stringify(buildRuntimePayload(identities)),
        ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET",
        TON_NETWORK: network
    };

    const parsed = loadRoomWalletRuntimeConfig(env);
    const registry = createRoomWalletRegistryFromEnv(env);

    assert.equal(parsed.entries.length, 64);
    assert.equal(registry.size(), 64);

    for (let roomNumber = 1; roomNumber <= 64; roomNumber += 1) {
        assert.equal(registry.require(roomNumber).address, identities[roomNumber - 1].address);
        assert.equal(registry.require(roomNumber).network, network);
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
}

test("CLI omits --network as TESTNET compatibility", () => {
    const parsed = parseProvisionCliArgs(["--output-dir", "G:\\secrets\\testnet"]);
    assert.equal(parsed.network, "testnet");
    assert.equal(parsed.networkExplicit, false);
    assert.equal(parsed.outputDir, "G:\\secrets\\testnet");
});

test("CLI requires explicit --network mainnet and rejects unknown values", () => {
    const mainnet = parseProvisionCliArgs([
        "--network",
        "mainnet",
        "--output-dir",
        "G:\\secrets\\mainnet"
    ]);
    assert.equal(mainnet.network, "mainnet");
    assert.equal(mainnet.networkExplicit, true);

    const testnet = parseProvisionCliArgs([
        "--network",
        "testnet",
        "--output-dir",
        "G:\\secrets\\testnet"
    ]);
    assert.equal(testnet.network, "testnet");
    assert.equal(testnet.networkExplicit, true);

    assert.throws(
        () => parseProvisionCliArgs([]),
        /usage:/
    );
    assert.throws(
        () => parseProvisionCliArgs(["--network", "mainnet"]),
        /usage:/
    );
    assert.throws(
        () => parseProvisionCliArgs(["--network", "--output-dir", "G:\\secrets"]),
        /missing --network value/
    );
    assert.throws(
        () => parseProvisionCliArgs(["--network", "staging", "--output-dir", "G:\\secrets"]),
        /testnet or mainnet/
    );
    assert.throws(
        () => parseProvisionCliArgs(["--output-dir", "G:\\secrets", "--extra"]),
        /unknown argument/
    );
});

test("CLI process rejects invalid network without generating wallets", () => {
    const result = spawnSync(process.execPath, [
        provisionCli,
        "--network",
        "prod",
        "--output-dir",
        path.join(os.tmpdir(), "ww-unused-output")
    ], {
        encoding: "utf8"
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /testnet or mainnet/);
    assert.doesNotMatch(result.stdout + result.stderr, /secretKey/);
});

test("CLI process rejects a relative output directory", () => {
    const result = spawnSync(process.execPath, [
        provisionCli,
        "--network",
        "testnet",
        "--output-dir",
        "relative-secrets"
    ], {
        encoding: "utf8"
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /absolute path/);
});

test("provisioner generates 64 sequential TESTNET WalletContractV4 identities", () => {
    const identities = generateRoomWalletIdentities();
    assertCatalogShape(identities, "testnet");
});

test("explicit --network testnet matches the legacy generator schema", () => {
    const identities = generateRoomWalletIdentities({ network: "testnet" });
    assertCatalogShape(identities, "testnet");
    assert.equal(provisionArtifactFilenames("testnet").master, MASTER_BACKUP_FILENAME);
    assert.equal(provisionArtifactFilenames("testnet").runtime, RUNTIME_JSON_FILENAME);
});

test("explicit --network mainnet generates 64 MAINNET-tagged WalletContractV4 identities", () => {
    const identities = generateRoomWalletIdentities({ network: "mainnet" });
    assertCatalogShape(identities, "mainnet");
    assert.ok(identities.every((entry) => entry.network !== "testnet"));
    assert.equal(provisionArtifactFilenames("mainnet").master, MAINNET_MASTER_BACKUP_FILENAME);
    assert.equal(provisionArtifactFilenames("mainnet").runtime, MAINNET_RUNTIME_JSON_FILENAME);
});

test("the same public key yields the same bounceable address on both networks", () => {
    const testnet = createDummyRoomWalletEntry(1, {
        network: "testnet",
        seedLabel: "wheelwin-address-semantics"
    });
    const mainnet = createDummyRoomWalletEntry(1, {
        network: "mainnet",
        seedLabel: "wheelwin-address-semantics"
    });

    assert.equal(testnet.address, mainnet.address);
    assert.equal(testnet.publicKey, mainnet.publicKey);
    assert.notEqual(testnet.network, mainnet.network);
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
    assertRuntimeAccepts(identities, "testnet");
});

test("generated MAINNET ROOM_WALLETS_JSON is accepted by the production parser", () => {
    const identities = generateRoomWalletIdentities({ network: "mainnet" });
    assertRuntimeAccepts(identities, "mainnet");
});

test("cross-network catalogs are rejected by the production parser", () => {
    const testnet = generateRoomWalletIdentities({ network: "testnet" });
    const mainnet = generateRoomWalletIdentities({ network: "mainnet" });

    assert.throws(
        () => loadRoomWalletRuntimeConfig({
            ROOM_WALLETS_JSON: JSON.stringify(buildRuntimePayload(testnet)),
            ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET",
            TON_NETWORK: "mainnet"
        }),
        /does not match TON_NETWORK/
    );

    assert.throws(
        () => loadRoomWalletRuntimeConfig({
            ROOM_WALLETS_JSON: JSON.stringify(buildRuntimePayload(mainnet)),
            ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET",
            TON_NETWORK: "testnet"
        }),
        /does not match TON_NETWORK/
    );

    const mixed = buildRuntimePayload(testnet);
    mixed[0] = { ...mixed[0], network: "mainnet" };

    assert.throws(
        () => loadRoomWalletRuntimeConfig({
            ROOM_WALLETS_JSON: JSON.stringify(mixed),
            ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET",
            TON_NETWORK: "testnet"
        }),
        /cannot mix network values|does not match TON_NETWORK/
    );
});

test("provisioner rejects unsafe output directories and overwrites", async () => {
    assert.throws(
        () => assertOutputDirSafe("relative-dir", repoRoot),
        /absolute path/
    );
    assert.throws(
        () => assertOutputDirSafe(path.join(repoRoot, "secrets"), repoRoot),
        /inside the Git repository/
    );
    assert.throws(
        () => assertOutputDirSafe(
            path.join("C:\\Users\\DAAT\\WheelWin-offline-secrets", RESERVED_TESTNET_PROVISION_OUTPUT_DIR_BASENAME),
            repoRoot,
            { network: "mainnet" }
        ),
        /historical Testnet/
    );

    const identities = generateRoomWalletIdentities();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ww-room-wallets-"));

    try {
        const first = await writeProvisionArtifacts(tempDir, {
            masterBackup: buildMasterBackup(identities),
            runtimePayload: buildRuntimePayload(identities),
            network: "testnet"
        });

        assert.equal(path.basename(first.masterPath), MASTER_BACKUP_FILENAME);
        assert.equal(path.basename(first.runtimePath), RUNTIME_JSON_FILENAME);
        assert.match(first.masterSha256, /^[0-9a-f]{64}$/);
        assert.match(first.runtimeSha256, /^[0-9a-f]{64}$/);

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
                runtimePayload: buildRuntimePayload(identities),
                network: "testnet"
            }),
            /refusing to overwrite/
        );
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test("Mainnet artifacts use Mainnet filenames and cannot share a Testnet output directory", async () => {
    const testnet = generateRoomWalletIdentities({ network: "testnet" });
    const mainnet = generateRoomWalletIdentities({ network: "mainnet" });
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ww-room-wallets-mainnet-"));

    try {
        const written = await writeProvisionArtifacts(tempDir, {
            masterBackup: buildMasterBackup(mainnet),
            runtimePayload: buildRuntimePayload(mainnet),
            network: "mainnet"
        });

        assert.equal(path.basename(written.masterPath), MAINNET_MASTER_BACKUP_FILENAME);
        assert.equal(path.basename(written.runtimePath), MAINNET_RUNTIME_JSON_FILENAME);

        const reread = JSON.parse(await readFile(written.runtimePath, "utf8"));
        assert.ok(reread.every((entry) => entry.network === "mainnet"));

        loadRoomWalletRuntimeConfig({
            ROOM_WALLETS_JSON: JSON.stringify(reread),
            ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET",
            TON_NETWORK: "mainnet"
        });

        await assert.rejects(
            () => writeProvisionArtifacts(tempDir, {
                masterBackup: buildMasterBackup(testnet),
                runtimePayload: buildRuntimePayload(testnet),
                network: "testnet"
            }),
            /already contains/
        );
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test("stdout summary never contains secret material", () => {
    const identities = generateRoomWalletIdentities({ network: "mainnet" });
    const stats = validateProvisionedCatalog(identities, { envNetwork: "mainnet" });
    const stdout = formatPublicSummaryLines(buildPublicSummary(stats, {
        masterPath: "G:\\secure\\room-wallets-mainnet-master-backup.json",
        runtimePath: "G:\\secure\\room-wallets-mainnet-ROOM_WALLETS_JSON.json",
        masterSha256: "a".repeat(64),
        runtimeSha256: "b".repeat(64),
        acl: "posix file modes used"
    })).join("\n");

    assert.match(stdout, /network=mainnet/);
    assert.match(stdout, /count=64/);
    assert.doesNotMatch(stdout, /secretKey=/i);
    assert.doesNotMatch(stdout, /"secretKey"/);
    assert.doesNotMatch(stdout, /mnemonic/i);
    assert.doesNotMatch(stdout, /"publicKey"/);
    assert.ok(!identities.some((entry) => stdout.includes(entry.secretKey)));
    assert.ok(!identities.some((entry) => stdout.includes(entry.publicKey)));
});

test("provisioner rejects incomplete catalogs and unknown networks", () => {
    assert.throws(
        () => generateRoomWalletIdentities({ count: 63 }),
        /exactly 64/
    );
    assert.throws(
        () => generateRoomWalletIdentities({ network: "foobar" }),
        /testnet or mainnet/
    );
    assert.throws(
        () => generateRoomWalletIdentities({ network: "" }),
        /testnet or mainnet/
    );
});
