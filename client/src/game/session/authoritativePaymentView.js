/**
 * C5.5 — Authoritative payment view helpers for Page4.
 *
 * Maps AuthoritativeSession.payment (server PAYMENT_* payloads) to Page4
 * presentation. Never invents STARTED/COMPLETED/FAILED and never auto-confirms.
 */

import { PAYMENT_STATUS } from "../../utils/gameSession.js";

const WAITING_CONTRACT_LABEL = "WAITING FOR PAYMENT…";

/**
 * Maps an authoritative settlement payment status onto the existing Page4 row
 * statuses. Returns null when payment has not arrived yet.
 */
export function mapAuthoritativePaymentToRowStatus(payment) {

    if (!payment?.status) {

        return null;

    }

    switch (payment.status) {

        case "STARTED":

            return PAYMENT_STATUS.pending;

        case "COMPLETED":

            return PAYMENT_STATUS.confirmed;

        case "FAILED":

            return PAYMENT_STATUS.failed;

        default:

            return null;

    }

}

/**
 * Smart-contract banner copy derived only from authoritative payment status.
 * Missing payment → waiting presentation (no fabricated "confirmed").
 */
export function mapAuthoritativePaymentToContractLabel(payment) {

    if (!payment?.status) {

        return WAITING_CONTRACT_LABEL;

    }

    switch (payment.status) {

        case "STARTED":

            return "SMART CONTRACT IS ISSUED";

        case "COMPLETED":

            return "SMART CONTRACT IS CONFIRMED";

        case "FAILED":

            return "SMART CONTRACT FAILED";

        default:

            return WAITING_CONTRACT_LABEL;

    }

}

/**
 * Next is enabled only when the server has reported COMPLETED.
 * Never derives confirmation from timers or mock player flags.
 */
export function isAuthoritativePaymentComplete(payment) {

    return payment?.status === "COMPLETED";

}

/**
 * True when Page4 should show the waiting panel instead of payment rows.
 * Waiting = no authoritative players yet OR payment payload not yet received.
 */
export function shouldShowPaymentWaiting(playersReady, payment) {

    return !playersReady || !payment?.status;

}
