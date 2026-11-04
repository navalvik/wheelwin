import assert from "node:assert/strict";
import test from "node:test";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";
import { LOBBY_SERVER_EVENTS } from "../socket/lobbyProtocol.js";

const originalFetch = globalThis.fetch;
const previousLocalBrowser = process.env.WHEELWIN_LOCAL_BROWSER;
const previousNetwork = process.env.TON_NETWORK;
let nextWalletId = 1;

function createBridge(network, deliver) {
    const bridge = Object.create(RoomLobbyBridge.prototype);
    bridge._socketToPlayer = new Map();
    bridge._noFriendsQueueBySocket = new Map();
    bridge._noFriendsQueueTimers = new Map();
    bridge._noFriendsQueues = new Map();
    bridge._noFriendsVerificationSockets = new Set();
    bridge._noFriendsDisconnectedSockets = new Set();
    bridge._noFriendsUserKeysByRoom = new Map();
    bridge._paymentApplicationBinding = {
        runtime: {
            network,
            observationService: { rateLimiter: { acquire: async () => {} } }
        }
    };
    bridge._resolveSocketTelegramUserId = () => null;
    bridge._deliverToSocket = deliver;
    bridge._logger = { warn() {} };
    return bridge;
}

async function submit(bridge, socketId, stake) {
    const accountHash = nextWalletId.toString(16).padStart(64, "0");
    nextWalletId += 1;
    await bridge._handleNoFriendsRequest(socketId, {
        nickname: "TEST",
        age: 30,
        baseStake: stake,
        wallet: `0:${accountHash}`
    });
}

function eventsForSocket(events, socketId) {
    return events.filter(event => event.socketId === socketId);
}

test("No Friends minimum wallet balance uses exact nanoTON thresholds before queue admission", async () => {
    process.env.WHEELWIN_LOCAL_BROWSER = "true";
    const bridges = [];

    try {
        for (const network of ["testnet", "mainnet"]) {
            process.env.TON_NETWORK = network;
            const observedHosts = [];
            let currentBalance = "0";
            globalThis.fetch = async (url) => {
                observedHosts.push(new URL(url).host);
                return {
                    ok: true,
                    json: async () => ({ result: { state: "active", balance: currentBalance } })
                };
            };

            const events = [];
            const bridge = createBridge(network, (socketId, eventName, payload) => {
                events.push({ socketId, eventName, payload });
            });
            bridges.push(bridge);
            const inputs = [
                { stake: 1, balance: "2599999999", admitted: false, minimum: "2.6" },
                { stake: 1, balance: "2600000000", admitted: true, minimum: null },
                { stake: 10, balance: "25999999999", admitted: false, minimum: "26" },
                { stake: 10, balance: "26000000000", admitted: true, minimum: null }
            ];

            for (let index = 0; index < inputs.length; index += 1) {
                const input = inputs[index];
                const socketId = `${network}-case-${index}`;
                currentBalance = input.balance;
                await submit(bridge, socketId, input.stake);
                const socketEvents = eventsForSocket(events, socketId);
                if (input.admitted) {
                    assert.equal(socketEvents.at(-1)?.eventName, LOBBY_SERVER_EVENTS.NO_FRIENDS_QUEUE_STATUS);
                    assert.equal(bridge._noFriendsQueueBySocket.has(socketId), true);
                } else {
                    const failure = socketEvents.at(-1);
                    assert.equal(failure?.eventName, LOBBY_SERVER_EVENTS.NO_FRIENDS_ERROR);
                    assert.equal(failure?.payload?.code, "INSUFFICIENT_BALANCE");
                    assert.equal(failure?.payload?.minimumBalanceGram, input.minimum);
                    assert.equal(bridge._noFriendsQueueBySocket.has(socketId), false);
                }
            }

            assert.deepEqual(
                observedHosts,
                Array(4).fill(network === "mainnet" ? "toncenter.com" : "testnet.toncenter.com")
            );

            const retrySocket = `${network}-retry`;
            currentBalance = "2599999999";
            await submit(bridge, retrySocket, 1);
            assert.equal(bridge._noFriendsQueueBySocket.has(retrySocket), false);
            currentBalance = "2600000000";
            await submit(bridge, retrySocket, 1);
            assert.equal(bridge._noFriendsQueueBySocket.has(retrySocket), true);
            assert.equal(observedHosts.length, 6, "each retry performs a new balance request");

            for (const timer of bridge._noFriendsQueueTimers.values()) clearTimeout(timer);
        }

        const events = [];
        const network = "testnet";
        process.env.TON_NETWORK = network;
        globalThis.fetch = async () => { throw new Error("RPC unavailable"); };
        const bridge = createBridge(network, (socketId, eventName, payload) => {
            events.push({ socketId, eventName, payload });
        });
        bridges.push(bridge);
        await submit(bridge, "network-error", 1);
        const failure = eventsForSocket(events, "network-error").at(-1);
        assert.equal(failure?.eventName, LOBBY_SERVER_EVENTS.NO_FRIENDS_ERROR);
        assert.equal(failure?.payload?.code, "WALLET_CHECK_FAILED");
        assert.equal(bridge._noFriendsQueueBySocket.has("network-error"), false);
    } finally {
        for (const bridge of bridges) {
            for (const timer of bridge._noFriendsQueueTimers.values()) clearTimeout(timer);
        }
        globalThis.fetch = originalFetch;
        if (previousLocalBrowser === undefined) delete process.env.WHEELWIN_LOCAL_BROWSER;
        else process.env.WHEELWIN_LOCAL_BROWSER = previousLocalBrowser;
        if (previousNetwork === undefined) delete process.env.TON_NETWORK;
        else process.env.TON_NETWORK = previousNetwork;
    }
});
