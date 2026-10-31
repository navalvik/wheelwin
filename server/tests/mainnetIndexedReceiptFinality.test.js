import test from "node:test";
import assert from "node:assert/strict";
import { ToncenterTransactionsClient } from "../payment/toncenter/ToncenterTransactionsClient.js";
import { MainnetIndexedReceiptFinalityInspector, MAINNET_INDEXED_RECEIPT_STATUS as STATUS } from "../mainnet/MainnetIndexedReceiptFinalityInspector.js";
import { MAINNET_TONCENTER_URL } from "../mainnet/MainnetReadOnlyPreflight.js";

const roomId = "mainnet-finality-room";
const account = "0:" + "a".repeat(64);
const sender = "0:" + "b".repeat(64);
const reference = "WW_FINALITY_1";
const unixSec = Math.floor(Date.now()/1000);
const env = { TON_NETWORK: "mainnet", ROOM_WALLET_PAYMENTS_ENABLED: "false" };
const query = { roomId, walletAddress: account, floorMs: unixSec*1000-10000,
    ceilingMs: unixSec*1000+10000, limit: 10 };
const reservation = {roomNumber: 5, address: account, reservedByRoomId: roomId};

function tx(overrides = {}) {
    return {
        hash: "tx-finality-mainnet-1",
        account,
        now: unixSec,
        emulated: false,
        block_ref: { workchain: 0, shard: "8000000000000000", seqno: 4288 },
        mc_block_seqno: 900,
        description: { aborted: false, compute_ph: { success: true }, action: { success: true } },
        in_msg: {
            source: sender, destination: account, value: "1000000000",
            message_content: { decoded: { type: "text_comment", comment: "WW1:"+reference } }
        },
        ...overrides
    };
}
function fixture({
    firstGlobalId = -239,
    secondGlobalId = -239,
    firstSeqno = 920,
    secondSeqno = 920,
    rows = [tx()],
    reservationValue = reservation,
    httpStatus = 200
} = {}) {
    const calls = [];
    let heads = 0;
    const client = new ToncenterTransactionsClient({
        baseUrl: MAINNET_TONCENTER_URL,
        apiKeyProvider: () => "MOCK-MAINNET-FINALITY-KEY",
        fetchImpl: async (url, init) => {
            const parsed = new URL(url);
            calls.push({ method: init.method, path: parsed.pathname, account: parsed.searchParams.get("account") });
            if (httpStatus !== 200) return new Response("error", { status: httpStatus });
            let body;
            if (parsed.pathname === "/api/v3/masterchainInfo") {
                heads += 1;
                body = {last: {global_id: heads === 1 ? firstGlobalId : secondGlobalId,
                    seqno: heads === 1 ? firstSeqno : secondSeqno}};
            } else body = {transactions: rows, address_book: {}};
            return new Response(JSON.stringify(body), { status: 200 });
        }
    });
    const make = (overrides = {}) => new MainnetIndexedReceiptFinalityInspector({
        env, client, resolveActiveRoomWallet: () => reservationValue, ...overrides
    });
    return { calls, client, make };
}

test("Mainnet receipt needs pre/post global-ID -239 and indexed masterchain depth", async () => {
    const f = fixture();
    const inspector = f.make();
    assert.equal(f.calls.length, 0);
    const result = await inspector.inspectRoom(query);
    assert.deepEqual(f.calls.map(x => x.path), [
        "/api/v3/masterchainInfo", "/api/v3/transactions", "/api/v3/masterchainInfo"
    ]);
    assert.ok(f.calls.every(x => x.method === "GET"));
    assert.equal(f.calls[1].account, account);
    assert.equal(result.globalId, -239);
    assert.equal(result.receipts.length, 1);
    const receipt = result.receipts[0];
    assert.equal(receipt.status, STATUS.INDEXED_DEPTH_OK);
    assert.equal(receipt.sourceAddress, sender);
    assert.equal(receipt.paymentReference, reference);
    assert.equal(receipt.amountAtomic, "1000000000");
    assert.equal(receipt.masterchainInclusionSeqno, 900);
    assert.equal(receipt.providerReportedFinality, true);
    assert.equal(receipt.settlementAuthorized, false);
    assert.equal(receipt.gameStartAuthorized, false);
    assert.equal(result.settlementAuthorized, false);
    assert.equal(result.gameStartAuthorized, false);
    assert.equal(inspector.sendTransfer, undefined);
    assert.equal(inspector.settlePayment, undefined);
});

test("first Testnet global-ID -3 fails before account transaction request", async () => {
    const f = fixture({firstGlobalId: -3});
    await assert.rejects(f.make().inspectRoom(query), /MAINNET_INCOMING_CHAIN_IDENTITY_INVALID/);
    assert.deepEqual(f.calls.map(x=>x.path), ["/api/v3/masterchainInfo"]);
});

test("post-transaction Testnet identity fails closed, not even one marked receipt", async () => {
    const f = fixture({secondGlobalId: -3});
    await assert.rejects(f.make().inspectRoom(query), /MAINNET_FINALITY_CHAIN_IDENTITY_INVALID/);
    assert.equal(f.calls.length, 3);
});

test("indexed watermark that has not reached required masterchain depth is pending", async () => {
    const f = fixture({secondSeqno: 900});
    const r = await f.make().inspectRoom(query);
    assert.equal(r.receipts[0].status, STATUS.DEPTH_PENDING);
    assert.equal(r.receipts[0].providerReportedFinality, false);
});

test("unindexed, emulated and malformed shard-block records never report finality", async () => {
    for (const modified of [
        {mc_block_seqno: null},
        {emulated: true},
        {block_ref: null},
        {block_ref: {workchain:0,shard:"bad",seqno:4}}
    ]) {
        const f = fixture({rows:[tx(modified)]});
        const r = await f.make().inspectRoom(query);
        // Emulated or malformed rows may be filtered out by strict mapper.
        assert.ok(r.receipts.length === 0
            || r.receipts.every(x => x.providerReportedFinality === false));
    }
});

test("another wallet's transaction never reports Mainnet finality", async () => {
    const foreign = "0:"+"c".repeat(64);
    const f = fixture({rows:[tx({account:foreign,in_msg:{
        source:sender,destination:foreign,value:"1000000000",
        message_content:{decoded:{type:"text_comment",comment:"WW1:"+reference}}
    }})]});
    const r = await f.make().inspectRoom(query);
    assert.ok(r.receipts.length===0
        || r.receipts.every(x=>x.status===STATUS.INVALID_ACCOUNT));
});

test("duplicate transaction hash fails closed even if indexed twice", async () => {
    const duplicated = tx();
    const f=fixture({rows:[duplicated,{...duplicated}]});
    const r=await f.make().inspectRoom(query);
    assert.equal(r.receipts.length,2);
    assert.ok(r.receipts.every(x=>x.status===STATUS.DUPLICATE_TRANSACTION));
});

test("incomplete provider window refuses to mark any receipt", async () => {
    const records = Array.from({length:10},(_,i)=>tx({hash:"mainnet-window-"+i}));
    const f=fixture({rows:records});
    const r=await f.make().inspectRoom(query);
    assert.equal(r.resultWindowComplete,false);
    assert.equal(r.receipts.length,10);
    assert.ok(r.receipts.every(x=>x.status===STATUS.WINDOW_INCOMPLETE));
});

test("inactive, unreserved or foreign room causes zero RPC", async () => {
    const f=fixture({reservationValue:null});
    await assert.rejects(f.make().inspectRoom(query), /MAINNET_INCOMING_WALLET_NOT_ACTIVE/);
    assert.equal(f.calls.length,0);
    const g=fixture();
    await assert.rejects(g.make().inspectRoom({...query,roomId:"foreign"}),
        /MAINNET_INCOMING_WALLET_NOT_ACTIVE/);
    assert.equal(g.calls.length,0);
});

test("invalid depth, disabled-payment protection and Testnet URL fail at construction", () => {
    const f=fixture();
    assert.throws(()=>f.make({minimumMasterchainDepth:0}), /MAINNET_FINALITY_DEPTH_INVALID/);
    assert.throws(()=>f.make({minimumMasterchainDepth:101}), /MAINNET_FINALITY_DEPTH_INVALID/);
    assert.throws(()=>f.make({env:{TON_NETWORK:"mainnet",ROOM_WALLET_PAYMENTS_ENABLED:"true"}}),
        /MAINNET_INCOMING_PAYMENTS_NOT_ALLOWED/);
    const wrong=new ToncenterTransactionsClient({
        baseUrl:"https://testnet.toncenter.com",apiKeyProvider:()=>"MOCK",
        fetchImpl:async()=>{throw Error("SHOULD_NOT_CALL");}
    });
    assert.throws(()=>f.make({client:wrong}),/MAINNET_INCOMING_RPC_ENDPOINT_MISMATCH/);
    assert.equal(f.calls.length,0);
});

test("Mainnet masterchain API error fails closed after transaction read", async () => {
    const calls=[];
    const rpc=new ToncenterTransactionsClient({
        baseUrl:MAINNET_TONCENTER_URL,apiKeyProvider:()=>"MOCK",
        fetchImpl:async(url)=>{
            const path=new URL(url).pathname;calls.push(path);
            if(calls.length===3)return new Response("unavailable",{status:503});
            return new Response(JSON.stringify(path.endsWith("masterchainInfo")
                ?{last:{global_id:-239,seqno:920}}
                :{transactions:[tx()],address_book:{}}),{status:200});
        }
    });
    const inspector=new MainnetIndexedReceiptFinalityInspector({
        env,client:rpc,resolveActiveRoomWallet:()=>reservation
    });
    await assert.rejects(inspector.inspectRoom(query), /MAINNET_FINALITY_HEAD_UNAVAILABLE/);
    assert.equal(calls.length,3);
});
