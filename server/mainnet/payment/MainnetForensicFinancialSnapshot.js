/** Bind the original financial snapshot directly to the shared archive flow. */
export function resolveFinancialArchiveRuntimeBinding({
    paymentMode,
    archiveConfig,
    testnetRuntime = null,
    mainnetRuntime = null
} = {}) {
    if (!archiveConfig || typeof archiveConfig !== "object") {
        throw new Error("FINANCIAL_ARCHIVE_CONFIG_REQUIRED");
    }
    if (paymentMode === "mainnet") {
        if (typeof mainnetRuntime?.financialSnapshot !== "function") {
            throw new Error("MAINNET_FINANCIAL_SNAPSHOT_UNAVAILABLE");
        }
        return Object.freeze({
            config: Object.freeze({ ...archiveConfig, prefix: "mainnet" }),
            financialSnapshotProvider: roomId => mainnetRuntime.financialSnapshot(roomId)
        });
    }
    if (paymentMode === "testnet") {
        if (typeof testnetRuntime?.financialSnapshot !== "function") {
            throw new Error("TESTNET_FINANCIAL_SNAPSHOT_UNAVAILABLE");
        }
        return Object.freeze({
            config: Object.freeze({ ...archiveConfig }),
            financialSnapshotProvider: roomId => testnetRuntime.financialSnapshot(roomId)
        });
    }
    throw new Error("PAYMENT_MODE_UNSUPPORTED_FOR_ARCHIVE");
}
