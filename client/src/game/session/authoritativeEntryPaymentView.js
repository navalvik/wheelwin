/**
 * C5.8C — Authoritative Entry Payment view helpers for Page4.
 *
 * Maps AuthoritativeSession.entryPayment only. Does not use settlement
 * AuthoritativeSession.payment / PaymentEngine payloads.
 */

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
            return "Paid";

        case "failed":
            return "Failed";

        case "cancelled":
            return "Cancelled";

        case "waiting":
        default:
            return "Waiting";

    }

}

export function mapEntrySmartContractLabel(smartContractStatus) {

    switch (smartContractStatus) {

        case "creating":
            return "Smart Contract Creating";

        case "created":
            return "Smart Contract Created";

        case "failed":
            return "Smart Contract Failed";

        case "waiting":
        default:
            return "Smart Contract Waiting";

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
            labelTitle: index === 0 ? "YOUR NICKNAME" : "PLAYER NICKNAME",
            nickname: roster?.nickname ?? "—",
            icon: roster?.icon ?? "—",
            walletRegistered: Boolean(seat.wallet),
            paymentStatus: seat.paymentStatus ?? "waiting",
            paymentStatusLabel: mapEntryPaymentStatusLabel(
                seat.paymentStatus ?? "waiting"
            )
        };

    });

}
