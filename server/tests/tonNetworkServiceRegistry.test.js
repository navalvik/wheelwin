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
