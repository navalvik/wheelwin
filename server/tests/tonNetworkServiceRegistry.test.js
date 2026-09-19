/**
 * Dual-network TON service registry isolation tests.
 *
 * Verifies room/payment blockchain I/O can select Testnet and Mainnet
 * independently without mutating or switching a shared TonService.
 */
import { TonNetworkServiceRegistry } from "../services/TonNetworkServiceRegistry.js";

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function createFakeService(network) {
    return {
        network,
        getActiveNetwork() { return network; },
        getTransport() { return { network }; }
    };
}

function testIndependentServices() {
    const created = [];

    const registry = new TonNetworkServiceRegistry({
        env: {
            TON_TESTNET_ENDPOINT: "https://testnet.example.invalid",
            TON_MAINNET_ENDPOINT: "https://mainnet.example.invalid",
            TON_POLL_INTERVAL_MS: "2000",
            TON_DEPLOY_MODE: "stub"
        },
        createService: ({ network, tonConfig }) => {
            created.push({ network, tonConfig });
            return createFakeService(network);
        }
    });

    const testnet = registry.get("testnet");
    const mainnet = registry.get("mainnet");

    assert(testnet !== mainnet, "Testnet and Mainnet must use different service instances");
    assert(testnet.getActiveNetwork() === "testnet", "Testnet service must remain Testnet");
    assert(mainnet.getActiveNetwork() === "mainnet", "Mainnet service must remain Mainnet");
    assert(registry.get("testnet") === testnet, "Testnet service must be stable");
    assert(registry.get("mainnet") === mainnet, "Mainnet service must be stable");
    assert(created.length === 2, "Registry must create exactly one service per network");
    assert(created[0].tonConfig.endpoint === "https://testnet.example.invalid", "Testnet endpoint must come from Testnet profile");
    assert(created[1].tonConfig.endpoint === "https://mainnet.example.invalid", "Mainnet endpoint must come from Mainnet profile");

    console.log("Dual-network registry isolation: passed");
}


function testNetworkScopedSigningMaterial() {
    const registry = new TonNetworkServiceRegistry({
        env: {
            TON_TESTNET_ENDPOINT: "https://testnet.example.invalid",
            TON_MAINNET_ENDPOINT: "https://mainnet.example.invalid",
            TON_POLL_INTERVAL_MS: "2000",
            TON_DEPLOY_MODE: "live",
            TON_DEPLOYER_MNEMONIC: "legacy-testnet-mnemonic",
            TON_TESTNET_DEPLOYER_MNEMONIC: "dedicated-testnet-mnemonic",
            TON_MAINNET_DEPLOYER_MNEMONIC: "dedicated-mainnet-mnemonic",
            TON_API_KEY: "legacy-api-key",
            TON_MAINNET_API_KEY: "dedicated-mainnet-api-key"
        },
        createService: ({ network }) => createFakeService(network)
    });

    const testnet = registry.getConfig("testnet");
    const mainnet = registry.getConfig("mainnet");

    assert(
        testnet.deployerMnemonic === "dedicated-testnet-mnemonic",
        "Testnet must prefer its dedicated deployer mnemonic"
    );
    assert(
        mainnet.deployerMnemonic === "dedicated-mainnet-mnemonic",
        "Mainnet must use its dedicated deployer mnemonic"
    );
    assert(
        mainnet.deployerMnemonic !== "legacy-testnet-mnemonic",
        "Mainnet must never inherit the legacy runtime/Testnet mnemonic"
    );
    assert(
        mainnet.apiKey === "dedicated-mainnet-api-key",
        "Mainnet must prefer its dedicated API key"
    );

    const mainnetWithoutDedicatedMnemonic = new TonNetworkServiceRegistry({
        env: {
            TON_MAINNET_ENDPOINT: "https://mainnet.example.invalid",
            TON_POLL_INTERVAL_MS: "2000",
            TON_DEPLOY_MODE: "live",
            TON_DEPLOYER_MNEMONIC: "legacy-testnet-mnemonic"
        },
        createService: ({ network }) => createFakeService(network)
    });

    assert(
        mainnetWithoutDedicatedMnemonic.getConfig("mainnet").deployerMnemonic === null,
        "Mainnet must fail closed when dedicated signing material is absent"
    );

    console.log("Network-scoped signing material isolation: passed");
}

function testInvalidNetworkRejected() {
    const registry = new TonNetworkServiceRegistry({
        createService: ({ network }) => createFakeService(network)
    });

    let rejected = false;

    try {
        registry.get("mainnet;switch-runtime");
    } catch {
        rejected = true;
    }

    assert(rejected, "Unsupported network must be rejected");
    console.log("Invalid network rejection: passed");
}

testIndependentServices();
testInvalidNetworkRejected();


testNetworkScopedSigningMaterial();
