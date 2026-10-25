import { SqlitePaymentIntentStore } from "../../payment/SqlitePaymentIntentStore.js";
import { RefundObligationStore } from "../../payment/refund/RefundObligationStore.js";
import { ProtectedRefundIntentJournal } from "../../payment/refund/ProtectedRefundIntentJournal.js";

const [, , db, refundDirectory, journalDirectory, intentId] = process.argv;
const intents = new SqlitePaymentIntentStore({ databasePath: db });
try {
    intents.initialize();
    const refunds = new RefundObligationStore({ dataDir: refundDirectory });
    refunds.initialize();
    const journal = new ProtectedRefundIntentJournal({
        directory: journalDirectory, refundStore: refunds, intentStore: intents
    });
    journal.claimWallet(intentId);
    console.log("CLAIMED");
    process.exitCode = 0;
} catch (error) {
    console.log(error?.code ?? error?.message ?? "UNKNOWN");
    process.exitCode = error?.code === "WALLET_ALREADY_LOCKED" ? 2 : 1;
} finally {
    intents.close();
}
