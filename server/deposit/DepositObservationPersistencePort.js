/**
 * R17.9L.7 — Persistence port for deposit_observation records.
 * Production adapter writes through TonFinancialPersistence.
 */

import { RecordNotFoundError } from "../persistence/TonFinancialPersistenceErrors.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../persistence/TonFinancialRecordTypes.js";
import { buildObservationId } from "./DepositObservation.js";

function observationMetadata(observation) {

    return {
        observationId: observation.observationId,
        depositId: observation.depositId,
        transactionHash: observation.transactionHash,
        wallet: observation.senderWallet,
        amount: observation.amount,
        status: observation.observationStatus,
        createdAt: observation.createdAt,
        updatedAt: observation.updatedAt,
        tonNetwork: observation.network
    };

}

export class DepositObservationPersistencePort {

    saveDepositObservation(_observation) {

        throw new Error("saveDepositObservation is not implemented");

    }

    loadDepositObservation(_observationId) {

        throw new Error("loadDepositObservation is not implemented");

    }

    findDepositObservation(_depositId, _transactionHash) {

        throw new Error("findDepositObservation is not implemented");

    }

    listDepositObservations(_depositId) {

        throw new Error("listDepositObservations is not implemented");

    }

}

export class InMemoryDepositObservationPersistence extends DepositObservationPersistencePort {

    constructor() {

        super();

        this._byId = new Map();

        this._byDepositTx = new Map();

        this._byDeposit = new Map();

    }

    _depositTxKey(depositId, transactionHash) {

        return buildObservationId(depositId, transactionHash);

    }

    saveDepositObservation(observation) {

        const record = observation.toRecord();

        this._byId.set(record.recordId, record);

        this._byDepositTx.set(
            this._depositTxKey(record.depositId, record.payload.transactionHash),
            record.recordId
        );

        const list = this._byDeposit.get(record.depositId) ?? [];

        if (!list.includes(record.recordId)) {

            list.push(record.recordId);

        }

        this._byDeposit.set(record.depositId, list);

        return record;

    }

    loadDepositObservation(observationId) {

        return this._byId.get(observationId) ?? null;

    }

    findDepositObservation(depositId, transactionHash) {

        const observationId = this._byDepositTx.get(
            this._depositTxKey(depositId, transactionHash)
        );

        return observationId ? this._byId.get(observationId) ?? null : null;

    }

    listDepositObservations(depositId) {

        const ids = this._byDeposit.get(depositId) ?? [];

        return ids
            .map((observationId) => this._byId.get(observationId))
            .filter(Boolean);

    }

}

export class TonFinancialDepositObservationPersistence extends DepositObservationPersistencePort {

    constructor(financialPersistence) {

        super();

        this._persistence = financialPersistence;

    }

    saveDepositObservation(observation) {

        return this._persistence.saveDepositObservation(
            observation.toPayload(),
            observationMetadata(observation)
        );

    }

    loadDepositObservation(observationId) {

        try {

            return this._persistence.loadDepositObservation(observationId);

        } catch (error) {

            if (error instanceof RecordNotFoundError || error?.name === "RecordNotFoundError") {

                return null;

            }

            throw error;

        }

    }

    findDepositObservation(depositId, transactionHash) {

        return this._persistence.findDepositObservation(depositId, transactionHash);

    }

    listDepositObservations(depositId) {

        return this._persistence.listDepositObservations(depositId);

    }

}
