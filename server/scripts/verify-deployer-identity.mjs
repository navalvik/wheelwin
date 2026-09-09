#!/usr/bin/env node
/**
 * Offline local verification of a Deployer/Oracle mnemonic against public pins.
 *
 * Does NOT load .env files. Does NOT use TON RPC. Does NOT write artifacts.
 *
 * Required process environment (session only — never commit, never .env, never argv):
 *   TON_DEPLOYER_MNEMONIC
 *   TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS
 *
 * Optional:
 *   TON_MAINNET_ORACLE_ADDRESS  (must equal the derived Deployer address if set)
 *
 * Usage (from server/):
 *   node scripts/verify-deployer-identity.mjs
 */

import {
    formatVerifyDeployerPublicLines,
    parseVerifyDeployerCliArgs,
    verifyDeployerIdentity
} from "./lib/verifyDeployerIdentity.js";

async function main() {

    parseVerifyDeployerCliArgs(process.argv.slice(2));

    const result = await verifyDeployerIdentity({
        mnemonic: process.env.TON_DEPLOYER_MNEMONIC,
        expectedAddress: process.env.TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS,
        oracleAddress: process.env.TON_MAINNET_ORACLE_ADDRESS || null
    });

    for (const line of formatVerifyDeployerPublicLines(result)) {
        console.log(line);
    }
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : "verification failed";
    console.error("Deployer identity verification FAIL");
    console.error(message);
    process.exitCode = 1;
});
