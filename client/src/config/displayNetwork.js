// Local development is Testnet. Only explicitly named Mainnet deployments
// display a Mainnet warning; payment authorization remains server-owned.
export function isTestnetDisplay(hostname = globalThis.window?.location?.hostname ?? "") {
    return !/^wheelwin-main(?:[.-]|$)/i.test(hostname);
}
