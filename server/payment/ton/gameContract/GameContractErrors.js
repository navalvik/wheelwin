/**
 * T2.3 — TonGameContractAdapter typed errors.
 */

export class GameContractAdapterError extends Error {

    constructor(message, code = "GAME_CONTRACT_ADAPTER_ERROR", details = null) {

        super(message);

        this.name = "GameContractAdapterError";

        this.code = code;

        this.details = details ?? null;

    }

}

export class ContractNotFoundError extends GameContractAdapterError {

    constructor(address) {

        super(
            `Game contract not found | address=${address}`,
            "CONTRACT_NOT_FOUND",
            { address }
        );

        this.name = "ContractNotFoundError";

    }

}

export class ContractAlreadyExistsError extends GameContractAdapterError {

    constructor(address) {

        super(
            `Game contract already exists | address=${address}`,
            "CONTRACT_ALREADY_EXISTS",
            { address }
        );

        this.name = "ContractAlreadyExistsError";

    }

}

export class ContractStateError extends GameContractAdapterError {

    constructor(message, details = null) {

        super(message, "CONTRACT_STATE_ERROR", details);

        this.name = "ContractStateError";

    }

}

export class SerializationError extends GameContractAdapterError {

    constructor(message, details = null) {

        super(message, "SERIALIZATION_ERROR", details);

        this.name = "SerializationError";

    }

}

export class DeserializationError extends GameContractAdapterError {

    constructor(message, details = null) {

        super(message, "DESERIALIZATION_ERROR", details);

        this.name = "DeserializationError";

    }

}

export class InvalidAddressError extends GameContractAdapterError {

    constructor(address, reason = "invalid_format") {

        super(
            `Invalid contract address | address=${address}`,
            "INVALID_ADDRESS",
            { address, reason }
        );

        this.name = "InvalidAddressError";

    }

}

export class UnsupportedContractVersionError extends GameContractAdapterError {

    constructor(version) {

        super(
            `Unsupported game contract version | version=${version}`,
            "UNSUPPORTED_CONTRACT_VERSION",
            { version }
        );

        this.name = "UnsupportedContractVersionError";

    }

}

export class InvalidContractResponseError extends GameContractAdapterError {

    constructor(method, details = null) {

        super(
            `Invalid game contract response | method=${method}`,
            "INVALID_CONTRACT_RESPONSE",
            { method, ...(details ?? {}) }
        );

        this.name = "InvalidContractResponseError";

    }

}
