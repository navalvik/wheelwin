/**
 * Fail-closed jetton master -> owner -> Jetton Wallet binding checks.
 *
 * Expected binding must be obtained from the pinned Testnet GRAM master
 * get_wallet_address(owner) execution; wallet get_wallet_data() must
 * independently report the same owner/master pair.
 *
 * This validator cannot authenticate caller-supplied getter results or prove
 * chain state. A separate trusted get-method execution & state proof is
 * required before these observations have settlement authority.
 */
import { tonAddressIdentityOrNull } from "../incoming/TonAddressIdentity.js";

function canonical(address) {
    return tonAddressIdentityOrNull(address);
}

export function inspectGramJettonMasterWalletBinding({
    jettonMaster,
    ownerWallet,
    observedJettonWallet,
    masterGetter,
    walletGetter
} = {}) {
    const master = canonical(jettonMaster);
    const owner = canonical(ownerWallet);
    const observed = canonical(observedJettonWallet);
    if (!master || !owner || !observed
        || master === owner || owner === observed || master === observed
        || !masterGetter || !walletGetter
        || masterGetter.method !== "get_wallet_address"
        || walletGetter.method !== "get_wallet_data"
        || masterGetter.exitCode !== 0
        || walletGetter.exitCode !== 0) return null;

    const masterContract = canonical(masterGetter.contractAddress);
    const masterOwnerArgument = canonical(masterGetter.ownerArgument);
    const derivedWallet = canonical(masterGetter.walletAddress);
    const walletContract = canonical(walletGetter.contractAddress);
    const returnedOwner = canonical(walletGetter.ownerAddress);
    const returnedMaster = canonical(walletGetter.jettonMasterAddress);

    if (masterContract !== master || masterOwnerArgument !== owner
        || derivedWallet !== observed || walletContract !== observed
        || returnedOwner !== owner || returnedMaster !== master) return null;

    // These are cross-checked read-only getter observations, not authenticated
    // historical state proofs or evidence that a particular transfer succeeded.
    return Object.freeze({
        jettonMaster: master,
        ownerWallet: owner,
        jettonWallet: observed,
        getterAddressesConsistent: true,
        getterChainStateAuthenticated: false,
        transferExecutionVerified: false,
        gramTransferVerified: false,
        paymentCreditAuthorized: false
    });
}
