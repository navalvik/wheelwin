import { calculatePaymentGram } from "./playerProfileRules.js";

export const PAYMENT_STATUS = {
    waiting: "waiting",
    pending: "pending",
    confirmed: "confirmed",
    failed: "failed"
};

export function getPaymentStatusLabel(status) {

    switch (status) {

        case PAYMENT_STATUS.confirmed:
            return "PAYMENT HAVE BEEN DONE";

        case PAYMENT_STATUS.pending:
            return "PAYMENT PROCESSING...";

        case PAYMENT_STATUS.failed:
            return "PAYMENT FAILED";

        case PAYMENT_STATUS.waiting:
        default:
            return "AWAITING FOR PAYMENT";

    }

}

export { calculatePaymentGram };
