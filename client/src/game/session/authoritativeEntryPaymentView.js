/**
 * C5.8C — Authoritative Entry Payment view helpers for Page4.
 *
 * Maps AuthoritativeSession.entryPayment only. Does not use settlement
 * AuthoritativeSession.payment / PaymentEngine payloads.
 */

import { resolveWheelIcon } from "../../components/game/WheelEngine/wheelUtils.js";

function resolveDisplayIcon(icon) {

    if (icon == null || icon === "" || icon === "—") {

        return "—";

    }

    return resolveWheelIcon(icon);

}

export function listEntryPaymentPlayers(entryPayment) {

    if (!Array.isArray(entryPayment?.players)) {

        return [];

    }

    return entryPayment.players;

}

export function hasEntryPaymentSession(entryPayment) {

    return Array.isArray(entryPayment?.players)
        && entryPayment.players.length > 0;

}

export function mapEntryPaymentStatusLabel(paymentStatus) {

    switch (paymentStatus) {

        case "paid":
            return "payment.paid";

        case "failed":
            return "payment.failed";

        case "cancelled":
            return "payment.cancelled";

        case "waiting":
        default:
            return "common.waiting";

    }

}

export function mapEntrySmartContractLabel(smartContractStatus) {

    switch (smartContractStatus) {

        case "creating":
            return "payment.creating";

        case "created":
            return "payment.created";

        case "failed":
            return "payment.smartContractFailed";

        case "waiting":
        default:
            return "common.waiting";

    }

}

/**
 * Page4 Next stays disabled until a later stage confirms entry payments.
 * C5.8C does not implement payment confirmation.
 */
export function isEntryPaymentComplete(entryPayment) {

    void entryPayment;

    return false;

}

/**
 * Waiting panel until the authoritative EntryPaymentSession arrives.
 */
export function shouldShowEntryPaymentWaiting(entryPayment) {

    return !hasEntryPaymentSession(entryPayment);

}

/**
 * Merge entry-payment seats with roster nickname/icon for Page4 rows.
 */
export function mapEntryPaymentRows(entryPayment, playersById = {}) {

    return listEntryPaymentPlayers(entryPayment).map((seat, index) => {

        const roster = playersById?.[seat.playerId] ?? null;

        return {
            key: seat.playerId ?? `entry-${index}`,
            playerId: seat.playerId,
            labelTitle: index === 0
                ? "player.yourNickname"
                : "player.playerNickname",
            nickname: roster?.nickname ?? "—",
            icon: resolveDisplayIcon(roster?.icon),
            walletRegistered: Boolean(seat.wallet),
            paymentStatus: seat.paymentStatus ?? "waiting",
            paymentStatusLabel: mapEntryPaymentStatusLabel(
                seat.paymentStatus ?? "waiting"
            )
        };

    });

}
