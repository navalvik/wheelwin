/**
 * Page4 labels come from the server-authoritative payment network.
 * Never claim Testnet for an unverified or Mainnet payment session.
 * UI text only: this module cannot authorize a payment or switch chains.
 */
export function getPage4NetworkPresentation(network) {
    if (network === "testnet") {
        return Object.freeze({
            label: "TESTNET",
            selectWallet: "SELECT TESTNET WALLET",
            mismatch: "Select the Testnet wallet entered on Page3 before confirming."
        });
    }
    if (network === "mainnet") {
        return Object.freeze({
            label: "MAINNET",
            selectWallet: "SELECT MAINNET WALLET",
            mismatch: "Select the Mainnet wallet entered on Page3 before confirming."
        });
    }
    return Object.freeze({
        label: "NETWORK UNVERIFIED",
        selectWallet: "SELECT REGISTERED WALLET",
        mismatch: "Select the wallet entered on Page3 before confirming."
    });
}
