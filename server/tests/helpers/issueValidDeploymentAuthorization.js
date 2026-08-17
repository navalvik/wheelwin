/**
 * R17.9L.5B — Test helper to issue a VALID DeploymentAuthorization.
 * Not a production path. Uses the real deposit → authorization domain.
 */

import { DepositSession } from "../../deposit/DepositSession.js";

export function threeDepositPlayers() {

    return [
        { playerId: "p1", wallet: "EQ_wallet_1", expectedAmount: 10 },
        { playerId: "p2", wallet: "EQ_wallet_2", expectedAmount: 10 },
        { playerId: "p3", wallet: "EQ_wallet_3", expectedAmount: 10 }
    ];

}

export function issueValidDeploymentAuthorization(coordinator, {
    roomId,
    gameId,
    network = "testnet"
} = {}) {

    const session = new DepositSession({
        roomId,
        gameId,
        metadata: { network }
    });

    session.bindPlayers(threeDepositPlayers());
    session.markAwaitingFunds();
    session.applyFunding({ wallet: "EQ_wallet_1", amount: 10, fundingEventId: `tx-${roomId}-1` });
    session.applyFunding({ wallet: "EQ_wallet_2", amount: 10, fundingEventId: `tx-${roomId}-2` });
    session.applyFunding({ wallet: "EQ_wallet_3", amount: 10, fundingEventId: `tx-${roomId}-3` });

    const created = coordinator.createFromDepositSession(session, { network });

    return coordinator.markValid(created.authorizationId);

}
