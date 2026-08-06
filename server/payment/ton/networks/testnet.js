/**
 * R7.66A — TON network presets (abstraction only; not wired into V4 deploy).
 */

export const testnet = Object.freeze({
    name: "testnet",
    networkId: "testnet",
    tonCenterEndpoint: "https://testnet.toncenter.com/api/v2/jsonRPC",
    explorerBaseUrl: "https://testnet.tonviewer.com",
    workchain: 0
});
