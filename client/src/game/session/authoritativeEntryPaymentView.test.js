import {
    hasEntryPaymentSession,
    isEntryPaymentComplete,
    mapEntryPaymentRows,
    mapEntryPaymentStatusLabel,
    mapEntrySmartContractLabel,
    shouldShowEntryPaymentWaiting
} from "./authoritativeEntryPaymentView.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

{

    assert(
        shouldShowEntryPaymentWaiting(null) === true,
        "missing session shows waiting"
    );

    assert(
        hasEntryPaymentSession(null) === false,
        "null is not a session"
    );

    assert(
        isEntryPaymentComplete(null) === false,
        "must not auto-complete missing entry payment"
    );

    assert(
        mapEntrySmartContractLabel("waiting") === "common.waiting",
        "default contract label"
    );

    assert(
        mapEntryPaymentStatusLabel("waiting") === "common.waiting",
        "default payment label"
    );

    assert(
        mapEntryPaymentStatusLabel("paid") === "payment.paid",
        "paid label"
    );

    assert(
        mapEntrySmartContractLabel("creating") === "payment.creating",
        "creating label"
    );

    assert(
        mapEntrySmartContractLabel("created") === "payment.created",
        "created label"
    );

    console.log("  empty / waiting guards passed");

}

{

    const entryPayment = {
        roomId: "ROOM1",
        createdAt: 1,
        smartContractStatus: "waiting",
        players: [
            { playerId: "p1", wallet: "EQAAAA", paymentStatus: "waiting" },
            { playerId: "p2", wallet: "EQBBBB", paymentStatus: "waiting" },
            { playerId: "p3", wallet: "EQCCCC", paymentStatus: "waiting" }
        ]
    };

    const playersById = {
        p1: { playerId: "p1", nickname: "Host", icon: "🎲" },
        p2: { playerId: "p2", nickname: "GueA", icon: "🎯" },
        p3: { playerId: "p3", nickname: "GueB", icon: "⭐" }
    };

    assert(
        shouldShowEntryPaymentWaiting(entryPayment) === false,
        "rows show once entry session arrives"
    );

    const rows = mapEntryPaymentRows(entryPayment, playersById);

    assert(rows.length === 3, "three entry rows");

    assert(
        rows.every((row) => row.walletRegistered === true),
        "wallets registered"
    );

    assert(
        rows.every((row) => row.paymentStatusLabel === "common.waiting"),
        "all payment rows Waiting"
    );

    assert(
        rows[0].labelTitle === "player.yourNickname",
        "first seat uses your-nickname key"
    );

    assert(rows[0].nickname === "Host", "roster nickname merged");

    console.log("  entry payment rows passed");

}

console.log("authoritativeEntryPaymentView.test.js: all assertions passed");
