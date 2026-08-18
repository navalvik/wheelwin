/**
 * R17.9L.7 — Fake blockchain source for DepositMonitor tests.
 * No TON calls. Emits synthetic observations into DepositMonitor.processObservation().
 */

import { DepositObservation } from "./DepositObservation.js";

export class FakeDepositBlockchainSource {

    constructor({ monitor = null } = {}) {

        this._monitor = monitor;

    }

    attachMonitor(monitor) {

        this._monitor = monitor;

    }

    emitObservation(input) {

        if (!this._monitor?.processObservation) {

            throw new Error("FakeDepositBlockchainSource requires an attached DepositMonitor");

        }

        return this._monitor.processObservation(input);

    }

    emitValidPayment({
        depositId,
        depositAddress,
        senderWallet,
        amount,
        transactionHash,
        network = "testnet",
        timestamp = Date.now()
    }) {

        return this.emitObservation({
            depositId,
            depositAddress,
            senderWallet,
            amount,
            transactionHash,
            network,
            timestamp
        });

    }

    emitInvalidWallet({
        depositId,
        depositAddress,
        senderWallet = "EQ_unknown_wallet",
        amount = 10,
        transactionHash,
        network = "testnet"
    }) {

        return this.emitObservation({
            depositId,
            depositAddress,
            senderWallet,
            amount,
            transactionHash,
            network
        });

    }

    emitWrongAmount({
        depositId,
        depositAddress,
        senderWallet,
        amount,
        transactionHash,
        network = "testnet"
    }) {

        return this.emitObservation({
            depositId,
            depositAddress,
            senderWallet,
            amount,
            transactionHash,
            network
        });

    }

    emitDuplicateTransaction(observation) {

        const payload = observation?.toPayload?.()
            ?? observation?.payload
            ?? observation;

        return this.emitObservation({
            depositId: payload.depositId,
            depositAddress: payload.depositAddress,
            senderWallet: payload.senderWallet ?? payload.wallet,
            amount: payload.amount,
            transactionHash: payload.transactionHash,
            network: payload.network ?? payload.tonNetwork ?? "testnet",
            timestamp: payload.timestamp
        });

    }

    emitFullDeposit({
        depositId,
        depositAddress,
        players,
        network = "testnet",
        timestamp = Date.now()
    }) {

        const results = [];

        for (const [index, player] of players.entries()) {

            results.push(this.emitValidPayment({
                depositId,
                depositAddress,
                senderWallet: player.wallet,
                amount: player.expectedAmount,
                transactionHash: player.transactionHash
                    ?? `tx-full-${depositId}-${index + 1}`,
                network,
                timestamp: timestamp + index
            }));

        }

        return results;

    }

    buildObservation(input) {

        return DepositObservation.fromInput(input);

    }

}
