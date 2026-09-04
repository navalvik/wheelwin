import assert from "node:assert/strict";
import test from "node:test";

import { ConfigurationError, ConfigurationIssueCollector } from "../config/ConfigurationError.js";
import { isSecretKey, redactSecretsFromObject, SECRET_ENV_KEYS } from "../config/secrets.js";
import { validateSecrets } from "../config/validators/validateSecrets.js";
import {
    createRoomWalletRegistryFromEnv,
    loadRoomWalletRuntimeConfig
} from "../payment/roomWallet/RoomWalletRuntimeResolver.js";
import {
    createDummyRoomWalletCatalog,
    createDummyRoomWalletEntry
} from "./helpers/dummyRoomWallet.js";

const DUMMY_MARKER = "DUMMY_ROOM_WALLET_SECRET_DO_NOT_LEAK";

function envWithWallets(wallets, extra = {}) {
    return {
        ROOM_WALLETS_JSON: JSON.stringify(wallets),
        ...extra
    };
}

function assertNoSecretLeak(value) {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    assert.doesNotMatch(serialized, /DUMMY_ROOM_WALLET_SECRET_DO_NOT_LEAK/);
    assert.doesNotMatch(serialized, /"secretKey"\s*:/);
}

test("A. ROOM_WALLETS_JSON is classified as a secret", () => {
    assert.equal(SECRET_ENV_KEYS.includes("ROOM_WALLETS_JSON"), true);
    assert.equal(isSecretKey("ROOM_WALLETS_JSON"), true);
});

test("B. secret redaction does not expose ROOM_WALLETS_JSON", () => {
    const payload = JSON.stringify([{ secretKey: DUMMY_MARKER }]);
    const redacted = redactSecretsFromObject({ ROOM_WALLETS_JSON: payload });

    assert.equal(redacted.ROOM_WALLETS_JSON, "[redacted]");
    assertNoSecretLeak(redacted);

    const error = new ConfigurationError({
        errors: [{
            key: "ROOM_WALLETS_JSON",
            reason: "invalid",
            received: payload,
            suggestedFix: "never print the value"
        }]
    });

    assert.equal(error.errors[0].received, "[redacted]");
    assertNoSecretLeak(error.message);
    assertNoSecretLeak(error.errors);
});

test("C. valid wallet configuration is accepted", () => {
    const wallet = createDummyRoomWalletEntry(1);
    const config = loadRoomWalletRuntimeConfig(envWithWallets([wallet]));

    assert.equal(config.entries.length, 1);
    assert.equal(config.entries[0].roomNumber, 1);
    assert.equal(config.entries[0].address, wallet.address);
    assert.equal(config.entries[0].network, "testnet");
    assert.equal(config.entries[0].workchain, 0);
});

test("D. malformed JSON is rejected", () => {
    assert.throws(
        () => loadRoomWalletRuntimeConfig({ ROOM_WALLETS_JSON: "{not-json" }),
        /ROOM_WALLETS_JSON is not valid JSON/
    );
});

test("E. missing required wallet fields are rejected", () => {
    const wallet = createDummyRoomWalletEntry(1);

    assert.throws(
        () => loadRoomWalletRuntimeConfig(envWithWallets([{
            roomNumber: 1,
            address: wallet.address,
            publicKey: wallet.publicKey
        }])),
        /secretKey for room 1 is required/
    );

    assert.throws(
        () => loadRoomWalletRuntimeConfig(envWithWallets([{
            roomNumber: 1,
            publicKey: wallet.publicKey,
            secretKey: wallet.secretKey
        }])),
        /address is required for room 1/
    );
});

test("F. duplicate roomNumber is rejected", () => {
    const first = createDummyRoomWalletEntry(1);
    const second = createDummyRoomWalletEntry(2);

    assert.throws(
        () => createRoomWalletRegistryFromEnv(envWithWallets([
            first,
            { ...second, roomNumber: 1 }
        ])),
        /duplicate roomNumber 1/
    );
});

test("G. invalid roomNumber is rejected", () => {
    const wallet = createDummyRoomWalletEntry(1);

    assert.throws(
        () => loadRoomWalletRuntimeConfig(envWithWallets([{ ...wallet, roomNumber: 0 }])),
        /roomNumber must be an integer from 1 to 64/
    );

    assert.throws(
        () => loadRoomWalletRuntimeConfig(envWithWallets([{ ...wallet, roomNumber: 65 }])),
        /roomNumber must be an integer from 1 to 64/
    );
});

test("H. missing room number is rejected when a complete catalog is required", () => {
    const incomplete = createDummyRoomWalletCatalog(63);

    assert.throws(
        () => loadRoomWalletRuntimeConfig({
            ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET",
            ROOM_WALLETS_JSON: JSON.stringify(incomplete)
        }),
        /exactly 64 wallets/
    );
});

test("I. incorrect address/publicKey/secretKey relationship is rejected", () => {
    const walletA = createDummyRoomWalletEntry(1);
    const walletB = createDummyRoomWalletEntry(2);

    assert.throws(
        () => loadRoomWalletRuntimeConfig(envWithWallets([{
            ...walletA,
            address: walletB.address
        }])),
        /address does not match WalletContractV4/
    );

    assert.throws(
        () => loadRoomWalletRuntimeConfig(envWithWallets([{
            ...walletA,
            publicKey: walletB.publicKey
        }])),
        /publicKey does not match secretKey/
    );

    assert.throws(
        () => loadRoomWalletRuntimeConfig(envWithWallets([{
            ...walletA,
            secretKey: walletB.secretKey
        }])),
        /publicKey does not match secretKey/
    );
});

test("J. Room Wallet count rules require 1..64 exactly once when intake is enabled", () => {
    const catalog = createDummyRoomWalletCatalog(64);
    const config = loadRoomWalletRuntimeConfig({
        TON_NETWORK: "testnet",
        ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET",
        ROOM_WALLETS_JSON: JSON.stringify(catalog)
    });

    assert.equal(config.entries.length, 64);
    assert.deepEqual(
        config.entries.map((entry) => entry.roomNumber),
        Array.from({ length: 64 }, (_, index) => index + 1)
    );

    const missingSeventeen = catalog.filter((entry) => entry.roomNumber !== 17);
    missingSeventeen.push({ ...createDummyRoomWalletEntry(17, { seedLabel: "other" }), roomNumber: 18 });

    assert.throws(
        () => loadRoomWalletRuntimeConfig({
            ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET",
            ROOM_WALLETS_JSON: JSON.stringify(missingSeventeen)
        }),
        /duplicate roomNumber 18/
    );
});

test("K. disabled Room Wallet intake works without ROOM_WALLETS_JSON", () => {
    const config = loadRoomWalletRuntimeConfig({});
    assert.deepEqual(config.entries, []);

    const collector = new ConfigurationIssueCollector();
    validateSecrets(collector, {
        DEVELOPER_AUTH_ENABLED: "false"
    }, {
        nodeEnv: "development",
        tonDeployMode: "stub",
        developer: { enabled: false, configured: false }
    });
    assert.equal(collector.size, 0);
});

test("L. validation errors do not expose secret material", () => {
    const collector = new ConfigurationIssueCollector();
    const payload = JSON.stringify([{ secretKey: DUMMY_MARKER }]);

    validateSecrets(collector, {
        DEVELOPER_AUTH_ENABLED: "false",
        ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET",
        ROOM_WALLETS_JSON: payload
    }, {
        nodeEnv: "development",
        tonDeployMode: "stub",
        developer: { enabled: false, configured: false }
    });

    assert.ok(collector.size > 0);

    try {
        collector.throwIfAny();
        assert.fail("expected ConfigurationError");
    } catch (error) {
        assert.equal(error.errors[0].key, "ROOM_WALLETS_JSON");
        assert.equal(error.errors[0].received, "[redacted]");
        assertNoSecretLeak(error.message);
        assertNoSecretLeak(error.errors);
    }
});

test("intake enabled without ROOM_WALLETS_JSON is rejected", () => {
    const collector = new ConfigurationIssueCollector();

    validateSecrets(collector, {
        DEVELOPER_AUTH_ENABLED: "false",
        ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET"
    }, {
        nodeEnv: "development",
        tonDeployMode: "stub",
        developer: { enabled: false, configured: false }
    });

    try {
        collector.throwIfAny();
        assert.fail("expected ConfigurationError");
    } catch (error) {
        assert.equal(error.errors[0].key, "ROOM_WALLETS_JSON");
        assert.match(error.errors[0].reason, /requires ROOM_WALLETS_JSON/);
        assert.equal(error.errors[0].received, "<undefined>");
    }
});

test("incompatible network values are rejected", () => {
    const testnet = createDummyRoomWalletEntry(1, { network: "testnet" });
    const mainnet = createDummyRoomWalletEntry(2, { network: "mainnet" });

    assert.throws(
        () => loadRoomWalletRuntimeConfig(envWithWallets([testnet, mainnet])),
        /cannot mix network values/
    );

    assert.throws(
        () => loadRoomWalletRuntimeConfig(envWithWallets([testnet], { TON_NETWORK: "mainnet" })),
        /network does not match TON_NETWORK/
    );

    assert.throws(
        () => loadRoomWalletRuntimeConfig(envWithWallets([{
            ...createDummyRoomWalletEntry(1),
            workchain: 1
        }])),
        /workchain must be 0/
    );
});
