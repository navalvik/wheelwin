/**
 * T2.3 — Backward-compatible TonService shim for legacy transport wiring.
 */

import { Address } from "@ton/core";

import {
    DEFAULT_TON_RETRY_POLICY,
    executeWithRetry,
    isInfrastructureFailure
} from "../../../services/ton/TonServiceRetry.js";

export function createLegacyTonServiceShim({
    transport,
    tonClient,
    tonConfig,
    retryPolicy = DEFAULT_TON_RETRY_POLICY,
    onRetryObservability = null
}) {

    if (!transport || !tonClient) {

        throw new Error("Legacy TonService shim requires transport and tonClient");

    }

    const readRpcRetryPolicy = Object.freeze({
        ...DEFAULT_TON_RETRY_POLICY,
        ...(retryPolicy ?? {})
    });

    function retryReadRpc(operationName, operation) {

        return executeWithRetry({
            operation,
            operationName,
            retryPolicy: readRpcRetryPolicy,
            shouldRetry: isInfrastructureFailure,
            onRetryObservability
        });

    }

    return {
        getActiveNetwork() {

            return tonConfig?.network ?? "testnet";

        },
        isConnected() {

            return true;

        },
        getTransport() {

            return transport;

        },
        getClient() {

            return tonClient;

        },
        async broadcastTransaction(bocBase64) {

            return transport.sendBoc(bocBase64);

        },
        async getAccount(address) {

            return retryReadRpc(
                "getAccount",
                () => transport.getAddressInformation(address)
            );

        },
        async getTransactions(address, query = {}) {

            return transport.getTransactions(address, query);

        },
        async getSeqno(walletAddress) {

            const address = Address.parse(walletAddress);

            return retryReadRpc("getSeqno", async () => {

                const result = await tonClient.runMethod(
                    address,
                    "seqno",
                    []
                );

                // @ton/ton runMethod returns stack as TupleReader, not an array.
                return result.stack.readNumber();

            });

        },
        async runGetMethod(address, method, stack = []) {

            return tonClient.runMethod(
                Address.parse(address),
                method,
                stack
            );

        }
    };

}
