/**
 * R7.67B — TON wallet identity diagnostics.
 */
import assert from "node:assert/strict";

import { mnemonicNew, mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { loadTonConfig } from "../config/ton.js";
import {
    assertDeployerWalletMatchesExpected,
    getTonWalletIdentityDebug,
    printTonWalletIdentityDebug,
    resetTonWalletIdentityDebugForTests,
    setTonWalletIdentityDebug,
    tonAddressesEqual
} from "../diagnostics/TonWalletIdentityDebug.js";
import {
    DEPLOYER_WALLET_CONTRACT_TYPE,
    DEPLOYER_WALLET_WORKCHAIN,
    deriveDeployerWalletIdentity
} from "../payment/ton/deriveDeployerWalletIdentity.js";

async function main() {

    resetTonWalletIdentityDebugForTests();

    const words = await mnemonicNew(24);
    const mnemonic = words.join(" ");
    const keyPair = await mnemonicToPrivateKey(words);
    const wallet = WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    });
    const expectedBounceable = wallet.address.toString({
        bounceable: true,
        urlSafe: true
    });
    const expectedNonBounceable = wallet.address.toString({
        bounceable: false,
        urlSafe: true
    });

    {
        const identity = await deriveDeployerWalletIdentity({
            mnemonic,
            network: "testnet"
        });

        assert.equal(identity.walletContractType, DEPLOYER_WALLET_CONTRACT_TYPE);
        assert.equal(identity.walletContractType, "WalletContractV4R2");
        assert.equal(identity.workchain, DEPLOYER_WALLET_WORKCHAIN);
        assert.equal(typeof identity.walletId, "number");
        assert.equal(identity.address, expectedBounceable);
        assert.equal(identity.network, "testnet");
        assert.ok(tonAddressesEqual(identity.address, expectedNonBounceable));
        console.log("  derive identity (V4R2): OK");
    }

    {
        assert.equal(
            tonAddressesEqual(expectedBounceable, expectedNonBounceable),
            true
        );
        assert.doesNotThrow(() => {
            assertDeployerWalletMatchesExpected(
                expectedBounceable,
                expectedNonBounceable
            );
        });
        assert.throws(
            () => assertDeployerWalletMatchesExpected(
                expectedBounceable,
                "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c"
            ),
            /identity mismatch/
        );
        assert.throws(
            () => assertDeployerWalletMatchesExpected(
                expectedBounceable,
                "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
                { network: "mainnet" }
            ),
            /network=mainnet/
        );
        console.log("  expected address validation: OK");
    }

    {
        const checkedAt = Date.now();
        setTonWalletIdentityDebug({
            walletContractType: DEPLOYER_WALLET_CONTRACT_TYPE,
            workchain: 0,
            walletId: wallet.walletId,
            address: expectedBounceable,
            network: "testnet",
            balanceTon: 1.25,
            balanceNano: "1250000000",
            lastCheckedAt: checkedAt,
            expectedAddress: expectedBounceable,
            identityMatch: true,
            mnemonicConfigured: true
        });

        const snapshot = getTonWalletIdentityDebug();
        assert.equal(snapshot.walletContractType, "WalletContractV4R2");
        assert.equal(snapshot.address, expectedBounceable);
        assert.equal(snapshot.balanceTon, 1.25);
        assert.equal(snapshot.lastCheckedAt, checkedAt);
        assert.equal(snapshot.identityMatch, true);

        printTonWalletIdentityDebug();
        console.log("  TON_WALLET_IDENTITY_DEBUG: OK");
    }

    {
        const cfg = loadTonConfig({
            TON_NETWORK: "testnet",
            TON_DEPLOYER_EXPECTED_ADDRESS: expectedBounceable
        });
        assert.equal(cfg.deployerExpectedAddress, expectedBounceable);
        assert.equal(cfg.deployerMnemonic, null);
        console.log("  ton config expected address: OK");
    }

    resetTonWalletIdentityDebugForTests();
    console.log("tonWalletIdentityDebug.test.js: all assertions passed");

}

main().catch((error) => {

    console.error(error);
    process.exit(1);

});
