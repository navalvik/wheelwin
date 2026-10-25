import test from "node:test";
import assert from "node:assert/strict";
import { fetchDualSourceRoomWalletTip } from "../payment/roomWallet/RoomWalletDualSourceAccountTip.js";

const ROOM = "0:c6423c1a3f43921316bd31f66287ad437b94d0b9421340f622619c9fa80173a6";
const HASH = "b".repeat(64);
const base64 = Buffer.from(HASH, "hex").toString("base64");

function mock(options = {}) {
    const requested = [];
    const fetchImpl = async (url, init) => {
        requested.push(url);
        assert.equal(init.method, "GET");
        if (options.failProvider === "tonapi" && url.includes("tonapi.io"))
            return { ok: false, status: 542 };
        if (options.failProvider === "toncenter" && url.includes("toncenter.com"))
            return { ok: false, status: 429 };
        const data = url.includes("tonapi.io")
            ? { last_transaction_lt: options.tonapiLt ?? "1200123456",
                last_transaction_hash: options.tonapiHash ?? HASH }
            : { accounts: [{
                address: ROOM,
                last_transaction_lt: options.toncenterLt ?? "1200123456",
                last_transaction_hash: options.toncenterHash ?? base64
            }] };
        if (options.malformed && url.includes("tonapi.io")) delete data.last_transaction_hash;
        return { ok: true, status: 200, async json() { return data; } };
    };
    return { fetchImpl, requested };
}

test("TonAPI hex and TON Center base64 prove the identical account tip", async () => {
    const api = mock();
    const result = await fetchDualSourceRoomWalletTip({
        roomWallet: ROOM, fetchImpl: api.fetchImpl
    });
    assert.equal(result.providersAgree, true);
    assert.equal(result.headLt, "1200123456");
    assert.equal(result.headHash, HASH);
    assert.equal(api.requested.length, 2);
    assert.ok(api.requested[0].includes("tonapi.io"));
    assert.ok(api.requested[1].includes("toncenter.com"));
});

test("different providers' latest logical times block release", async () => {
    const api = mock({ toncenterLt: "1200123457" });
    await assert.rejects(fetchDualSourceRoomWalletTip({
        roomWallet: ROOM, fetchImpl: api.fetchImpl
    }), e => e.code === "WALLET_HEAD_PROVIDERS_DISAGREE");
});

test("different hashes with same LT block release", async () => {
    const api = mock({ toncenterHash: Buffer.from("a".repeat(64), "hex").toString("base64") });
    await assert.rejects(fetchDualSourceRoomWalletTip({
        roomWallet: ROOM, fetchImpl: api.fetchImpl
    }), e => e.code === "WALLET_HEAD_PROVIDERS_DISAGREE");
});

test("HTTP 542 or 429 cannot be interpreted as no new transfers", async () => {
    for (const failProvider of ["tonapi", "toncenter"]) {
        const api = mock({ failProvider });
        await assert.rejects(fetchDualSourceRoomWalletTip({
            roomWallet: ROOM, fetchImpl: api.fetchImpl
        }), e => e.code === "WALLET_HEAD_HTTP_FAILURE");
    }
});

test("missing last transaction hash never authorizes room-number reuse", async () => {
    const api = mock({ malformed: true });
    await assert.rejects(fetchDualSourceRoomWalletTip({
        roomWallet: ROOM, fetchImpl: api.fetchImpl
    }), e => e.code === "WALLET_HEAD_FIELDS_UNAVAILABLE");
});

test("recipient wallet's address cannot be substituted as source Room Wallet", async () => {
    await assert.rejects(fetchDualSourceRoomWalletTip({
        roomWallet: "invalid", fetchImpl: mock().fetchImpl
    }), e => e.code === "WALLET_HEAD_IDENTITY_INVALID");
});
