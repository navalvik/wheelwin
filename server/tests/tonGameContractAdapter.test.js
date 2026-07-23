import assert from "node:assert/strict";

import { TonGameContractAdapter } from "../payment/TonGameContractAdapter.js";
import { MockTonTransport } from "../payment/ton/MockTonTransport.js";
import { buildGameEscrowWallet } from "../payment/ton/buildGameEscrowStateInit.js";

{
    const escrow = buildGameEscrowWallet({
        contractId: "contract_1",
        snapshot: {
            gameId: "g1",
            roomId: "r1",
            totalPot: 30,
            players: [
                { playerId: "p1", wallet: "EQ1", requiredGram: 10 }
            ]
        }
    });

    assert.ok(escrow.addressFriendly.startsWith("EQ"));

    const again = buildGameEscrowWallet({
        contractId: "contract_1",
        snapshot: {
            gameId: "g1",
            roomId: "r1",
            totalPot: 30,
            players: [
                { playerId: "p1", wallet: "EQ1", requiredGram: 10 }
            ]
        }
    });

    assert.equal(escrow.addressFriendly, again.addressFriendly);

}

{
    const transport = new MockTonTransport();

    const adapter = new TonGameContractAdapter({
        tonConfig: {
            endpoint: "http://localhost/mock",
            apiKey: null,
            deployerMnemonic: null
        },
        transport
    });

    const result = await adapter.deploy({
        contractId: "contract_live_1",
        snapshot: {
            gameId: "game_1",
            roomId: "room_1",
            totalPot: 30,
            players: []
        }
    });

    assert.equal(result.ok, true);

    assert.ok(result.contractAddress.startsWith("EQ"));

    assert.ok(result.deploymentTxId);

    assert.equal(transport.sentBocs.length, 1);

}

console.log("tonGameContractAdapter.test.js: all assertions passed");
