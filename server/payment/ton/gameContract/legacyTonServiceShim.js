/**
 * T2.3 — Backward-compatible TonService shim for legacy transport wiring.
 */

import { Address } from "@ton/core";

export function createLegacyTonServiceShim({
    transport,
    tonClient,
    tonConfig
}) {

    if (!transport || !tonClient) {

        throw new Error("Legacy TonService shim requires transport and tonClient");

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

            return transport.getAddressInformation(address);

        },
        async getTransactions(address, query = {}) {

            return transport.getTransactions(address, query);

        },
        async getSeqno(walletAddress) {

            const result = await tonClient.runMethod(
                Address.parse(walletAddress),
                "seqno",
                []
            );

            // @ton/ton runMethod returns stack as TupleReader, not an array.
            return result.stack.readNumber();

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
