import {
    ENTRY_PAYMENT_STATUS,
    ENTRY_SMART_CONTRACT_STATUS,
    EntryPaymentSession
} from "../models/EntryPaymentSession.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

{

    const session = EntryPaymentSession.createInitial("ROOM1", [
        { playerId: "p1", wallet: "EQ" + "A".repeat(46) },
        { playerId: "p2", wallet: "EQ" + "B".repeat(46) },
        { playerId: "p3", wallet: null }
    ]);

    assert(session.roomId === "ROOM1", "roomId set");

    assert(
        session.smartContractStatus === ENTRY_SMART_CONTRACT_STATUS.WAITING,
        "smart contract starts waiting"
    );

    assert(
        session.players.length === 3,
        "three players in entry session"
    );

    assert(
        session.players.every(
            (player) => player.paymentStatus === ENTRY_PAYMENT_STATUS.WAITING
        ),
        "every player paymentStatus starts waiting"
    );

    assert(
        session.players[0].wallet.startsWith("EQ"),
        "wallet copied from roster"
    );

    const snap = session.toSnapshot();

    assert(snap.roomId === "ROOM1", "snapshot roomId");

    assert(
        snap.players[2].wallet === null,
        "null wallet preserved in snapshot"
    );

    assert(
        snap.smartContractStatus === "waiting",
        "snapshot smartContractStatus"
    );

    console.log("  EntryPaymentSession initial state passed");

}

// C5.8D — waiting → paid and smart contract waiting → creating → created.
{

    let session = EntryPaymentSession.createInitial("ROOM2", [
        { playerId: "a", wallet: "EQ1" },
        { playerId: "b", wallet: "EQ2" },
        { playerId: "c", wallet: "EQ3" }
    ]);

    session = session.withPlayerPaid("a");

    assert(
        session.players[0].paymentStatus === ENTRY_PAYMENT_STATUS.PAID,
        "player a paid"
    );

    assert(
        session.players[1].paymentStatus === ENTRY_PAYMENT_STATUS.WAITING,
        "player b still waiting"
    );

    assert(session.areAllPlayersPaid() === false, "not all paid yet");

    const duplicate = session.withPlayerPaid("a");

    assert(duplicate === session, "duplicate paid is no-op");

    session = session.withPlayerPaid("b").withPlayerPaid("c");

    assert(session.areAllPlayersPaid() === true, "all paid");

    const skippedContract = session.withSmartContractStatus(
        ENTRY_SMART_CONTRACT_STATUS.CREATED
    );

    assert(
        skippedContract === session,
        "cannot skip creating → created"
    );

    session = session.withSmartContractStatus(
        ENTRY_SMART_CONTRACT_STATUS.CREATING
    );

    assert(
        session.smartContractStatus === ENTRY_SMART_CONTRACT_STATUS.CREATING,
        "creating"
    );

    session = session.withSmartContractStatus(
        ENTRY_SMART_CONTRACT_STATUS.CREATED
    );

    assert(
        session.smartContractStatus === ENTRY_SMART_CONTRACT_STATUS.CREATED,
        "created"
    );

    console.log("  EntryPaymentSession lifecycle transitions passed");

}

console.log("entryPaymentSession.test.js: all assertions passed");
