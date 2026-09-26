export function pushTonDeployDebugStage(stage, fields = {}) {

    if (!_tonDeployDebug) {

        beginTonDeployDebug({});

    }

    if (stage) {

        _tonDeployDebug.stage.push(stage);

    }

    const allowed = [
        "roomId",
        "gameId",
        "deployerAddress",
        "deployerWalletId",
        "seqno",
        "escrowAddress",
        "valueTon",
        "errorName",
        "errorMessage",
        "tonCenterStatus",
        "tonCenterResponse",
        "tonCenterEndpoint",
        // R7.70C2.6 — sequential deployer confirmation diagnostics
        "operation",
        "destination",
        "broadcastResult",
        "confirmationStatus",
        "confirmedSeqno",
        "matchedTxHash",
        "confirmationDurationMs",
        "failureReason",
        // R17.8M.2 — deployer balance preflight diagnostics
        "network",
        "availableBalance",
        "requiredBalance"
    ];

    for (const key of allowed) {

        if (Object.prototype.hasOwnProperty.call(fields, key)) {

            _tonDeployDebug[key] = fields[key];

        }

    }

    _tonDeployDebug.timestamp = Date.now();

    return getTonDeployDebug();

}

/**
 * @returns {object|null}
 */
export function getTonDeployDebug() {

    if (!_tonDeployDebug) {

        return null;

    }

    return Object.freeze({
        timestamp: _tonDeployDebug.timestamp,
        roomId: _tonDeployDebug.roomId,
        gameId: _tonDeployDebug.gameId,
        deployStarted: _tonDeployDebug.deployStarted === true,
        deployerAddress: _tonDeployDebug.deployerAddress,
        deployerWalletId: _tonDeployDebug.deployerWalletId,
        seqno: _tonDeployDebug.seqno,
        escrowAddress: _tonDeployDebug.escrowAddress,
        valueTon: _tonDeployDebug.valueTon,
        stage: Object.freeze([..._tonDeployDebug.stage]),
        currentStage: _tonDeployDebug.stage[_tonDeployDebug.stage.length - 1]
            ?? null,
        errorName: _tonDeployDebug.errorName,
        errorMessage: _tonDeployDebug.errorMessage,
        tonCenterStatus: _tonDeployDebug.tonCenterStatus,
        tonCenterResponse: _tonDeployDebug.tonCenterResponse,
        tonCenterEndpoint: _tonDeployDebug.tonCenterEndpoint,
        operation: _tonDeployDebug.operation ?? null,
        destination: _tonDeployDebug.destination ?? null,
        broadcastResult: _tonDeployDebug.broadcastResult ?? null,
        confirmationStatus: _tonDeployDebug.confirmationStatus ?? null,
        confirmedSeqno: _tonDeployDebug.confirmedSeqno ?? null,
        matchedTxHash: _tonDeployDebug.matchedTxHash ?? null,
        confirmationDurationMs: _tonDeployDebug.confirmationDurationMs ?? null,
        failureReason: _tonDeployDebug.failureReason ?? null,
    });

}

export function resetTonDeployDebugForTests() {

    _tonDeployDebug = null;


    _lastStageAtByRoom.clear();

    _attemptByRoom.clear();

}

/**
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {string}
 */
export function safeSerialize(value, depth = 0) {

    if (value === null) {

        return "null";

    }

    if (value === undefined) {

        return "undefined";

    }

    if (depth > 4) {

        return "[MaxDepth]";

    }

    try {

        return JSON.stringify(value, (_key, nested) => {

            if (typeof nested === "bigint") {

                return String(nested);

            }

            if (nested instanceof Error) {

                return {
                    name: nested.name,
                    message: nested.message,
                    stack: nested.stack
                };

            }

            if (typeof nested === "function") {

                return `[Function ${nested.name || "anonymous"}]`;

            }

            return nested;

        }, 2);

    } catch (error) {

        return `[Unserializable: ${error?.message ?? error}]`;

    }

}

/**
 * @param {string} title
 * @param {Record<string, unknown>} fields
 */
export function printDeployBlock(title, fields) {

    console.log("======================================================");
    console.log(title);
    console.log("======================================================");

    for (const [key, value] of Object.entries(fields)) {

        if (value !== null && typeof value === "object") {

            console.log(`${key}:`, safeSerialize(value));

        } else {

            console.log(`${key}:`, value);

        }

    }

    console.log("======================================================");

}
