import { RefundObligationStore } from "../../payment/refund/RefundObligationStore.js";

// Offline subprocess fixture: no provider, key, network or send capability.
const [root, obligationId, source] = process.argv.slice(2);
try {
    const store = new RefundObligationStore({ dataDir: root }).initialize();
    const obligation = store.get(obligationId);
    store.markSubmissionUnknown(obligationId, { sourceWalletAddress: source, attempt: {
        networkName: "TESTNET", globalId: -3, idempotencyKey: obligation.idempotencyKey,
        attemptId: "worker", state: "SUBMISSION_UNKNOWN", startedAtMs: 1800000000000,
        completedAtMs: null, outgoingTransactionId: null, errorCode: null
    } });
    process.stdout.write("CLAIMED");
} catch {
    process.stdout.write("HELD");
}
