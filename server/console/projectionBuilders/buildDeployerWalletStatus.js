import { fromNano } from "@ton/core";

import { deriveDeployerWalletIdentity } from "../../payment/ton/deriveDeployerWalletIdentity.js";
import { evaluateDeployerWalletReadiness } from "./evaluateDeployerWalletReadiness.js";

/**
 * R17.8M.1 — Live deployer wallet observability (read-only, no secrets).
 *
 * @param {{
 *   runtimeConfig?: { ton?: { deployerMnemonic?: string|null, network?: string|null } }|null,
 *   tonService?: { getBalance?: Function, getSeqno?: Function }|null
 * }} params
 */
export async function buildDeployerWalletStatus({
    runtimeConfig = null,
    tonService = null
} = {}) {

    const tonConfig = runtimeConfig?.ton ?? null;
    const mnemonic = tonConfig?.deployerMnemonic ?? null;
    const network = tonConfig?.network ?? null;

    const identity = await deriveDeployerWalletIdentity({
        mnemonic,
        network
    });

    let balanceNano = 0n;
    let seqno = null;

    if (tonService?.getBalance && tonService?.getSeqno) {

        balanceNano = await tonService.getBalance(identity.address);
        seqno = await tonService.getSeqno(identity.address);

    }

    const readiness = evaluateDeployerWalletReadiness(balanceNano);

    return Object.freeze({
        network: identity.network ?? network ?? "unknown",
        walletType: identity.walletContractType,
        walletId: identity.walletId,
        address: identity.address,
        balance: fromNano(balanceNano),
        seqno,
        lastCheckedAt: new Date().toISOString(),
        readiness
    });

}
