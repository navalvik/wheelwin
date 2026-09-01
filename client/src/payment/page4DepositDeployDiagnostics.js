/**
 * R18-S16 — Logging-only Page4 Deposit deploy diagnostics.
 * Observes gate / build / send / wallet-result fields. Does not invent
 * deployValueNanotons, hashes, or broadcast success.
 */

const FIELD_ORDER = [
    "action",
    "canDeploy",
    "canFund",
    "deployValueNanotons",
    "packageDeployValueNanotons",
    "amount",
    "depositAddress",
    "hasStateInit",
    "validUntil",
    "outcome",
    "hasBoc",
    "bocLength",
    "resultType",
    "errorName",
    "errorCode",
    "errorMessage"
];

export function formatPage4DepositDeployLog(event, fields = {}) {

    const parts = [`[R18-S16 Page4DepositDeploy] event=${event}`];

    for (const key of FIELD_ORDER) {

        const value = fields[key];

        if (value === undefined || value === null || value === "") {

            continue;

        }

        parts.push(`${key}=${value}`);

    }

    return parts.join(" | ");

}

export function logPage4DepositDeploy(event, fields = {}) {

    console.info(formatPage4DepositDeployLog(event, fields));

}

export function classifyDepositWalletError(error) {

    const name = String(error?.name ?? "");
    const message = String(error?.message ?? "");
    const code = error?.code ?? error?.errorCode ?? null;

    if (
        code === 300
        || /reject/i.test(name)
        || /reject/i.test(message)
    ) {

        return "WALLET_REJECTION";

    }

    return "TONCONNECT_SEND_FAILURE";

}

export function describeTonConnectResult(result) {

    if (result == null) {

        return {
            resultType: "null",
            hasBoc: false
        };

    }

    if (typeof result !== "object") {

        return {
            resultType: typeof result,
            hasBoc: false
        };

    }

    const boc = result.boc;

    return {
        resultType: "object",
        hasBoc: typeof boc === "string" && boc.length > 0,
        bocLength: typeof boc === "string" ? boc.length : undefined
    };

}
