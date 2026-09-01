/**
 * R18-S16 — Logging-only formatter for Deposit chain observation.
 * Does not change activation decisions. Callers pass already-read fields.
 */

export function formatDepositChainLog({
    event,
    roomId = null,
    depositId = null,
    depositAddress = null,
    accountState = undefined,
    lastLt = undefined,
    lastHash = undefined,
    activationStatus = undefined,
    codeHash = undefined
} = {}) {

    const parts = [
        `[R18-S16 DepositChain] event=${event}`,
        `roomId=${roomId ?? "null"}`,
        `depositId=${depositId ?? "null"}`,
        `depositAddress=${depositAddress ?? "null"}`
    ];

    if (accountState !== undefined) {

        parts.push(`accountState=${accountState ?? "null"}`);

    }

    if (lastLt !== undefined) {

        parts.push(`lastLt=${lastLt ?? "null"}`);

    }

    if (lastHash !== undefined) {

        parts.push(`lastHash=${lastHash ?? "null"}`);

    }

    if (activationStatus !== undefined) {

        parts.push(`activationStatus=${activationStatus ?? "null"}`);

    }

    if (codeHash !== undefined) {

        parts.push(`codeHash=${codeHash ?? "null"}`);

    }

    return parts.join(" | ");

}
