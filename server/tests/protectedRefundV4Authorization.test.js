import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { WalletContractV4 } from "@ton/ton";
import { Address, beginCell, external, internal, storeMessage, storeMessageRelaxed, SendMode } from "@ton/core";
import { verifyProtectedRefundV4Authorization } from "../payment/refund/ProtectedRefundV4Authorization.js";

const TO = "0:" + "b".repeat(64);
const NOW = 1_800_000_000_000;
const GROSS = 1_000_000_000;
const FEE = 1_388_278;
const NET = GROSS - FEE;

function fx(options = {}) {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({format:"der",type:"spki"}).subarray(-32);
    const wallet = WalletContractV4.create({workchain:0, publicKey});
    const seqno = options.seqno ?? 7;
    const validUntil = Math.floor(NOW / 1000) + 120;
    const toWallet = options.toWallet ?? TO;
    const netAtomic = options.netAtomic ?? NET;
    const signing = beginCell().storeUint(wallet.walletId, 32)
        .storeUint(validUntil,32).storeUint(seqno,32)
        .storeUint(0,8).storeUint(SendMode.PAY_GAS_SEPARATELY,8)
        .storeRef(beginCell().store(storeMessageRelaxed(internal({
            to:Address.parse(toWallet),value:BigInt(netAtomic),bounce:true
        }))).endCell()).endCell();
    const signature = sign(null, signing.hash(), pair.privateKey);
    const sig = options.mutateSignature
        ? Buffer.from(signature).fill(0,0,1)
        : signature;
    const body = beginCell().storeBuffer(sig).storeBuilder(signing.asBuilder()).endCell();
    const envelope = beginCell().store(storeMessage(external({
        to: wallet.address, body
    }))).endCell();
    const bocBase64 = envelope.toBoc().toString("base64");
    const account = wallet.address.toRawString().toLowerCase();
    const keyHex = publicKey.toString("hex");
    const codeHash = wallet.init.code.hash().toString("hex");
    const tipHash = "e".repeat(64);
    const snapshot = (provider, overrides={})=>({
        provider, network:"testnet", account, status:"active",
        seqno, publicKeyHex:keyHex, codeHash,
        tipLt:"105271924000001", tipHash,
        balanceAtomic:"4000000000", observedAtMs:NOW-1000,
        ...overrides
    });
    const snapshots=[snapshot("tonapi"),snapshot("toncenter-v3")];
    const params = {
        fromWallet:account,toWallet,netAtomic,grossAtomic:GROSS,
        bocBase64, snapshots,nowMs:NOW
    };
    return { params, wallet, pair, snapshot, account, publicKey };
}

test("valid real Ed25519 signature binds V4R2 wallet address and two-source seqno",()=>{
    const {params, wallet} = fx();
    const result = verifyProtectedRefundV4Authorization(params);
    assert.equal(result.signatureAuthenticated,true);
    assert.equal(result.walletAddressDerivedFromPublicKey,true);
    assert.equal(result.observedSeqnoMatches,true);
    assert.equal(result.seqno,7);
    assert.equal(result.roomWallet,wallet.address.toRawString().toLowerCase());
    assert.equal(result.publicKeyHex,params.snapshots[0].publicKeyHex);
    assert.equal(result.broadcastAuthorized,false);
    assert.equal(result.walletReleaseAuthorized,false);
});
test("forged Ed25519 signature is rejected even when every BOC field matches",()=>{
    const {params}=fx({mutateSignature:true});
    assert.throws(()=>verifyProtectedRefundV4Authorization(params),{code:"PREFLIGHT_SIGNATURE_INVALID"});
});
test("two indexers with different seqno, tip or public key fail closed",()=>{
    const {params,snapshot}=fx();
    for(const changes of [{seqno:8},{tipHash:"a".repeat(64)},{publicKeyHex:"c".repeat(64)},{balanceAtomic:"3000000000"}]){
        const snaps=[params.snapshots[0],snapshot("toncenter-v3",changes)];
        assert.throws(()=>verifyProtectedRefundV4Authorization({...params,snapshots:snaps}));
    }
});
test("stale state, future snapshot, invalid source and missing two sources reject",()=>{
    const {params,snapshot}=fx();
    for(const changed of [
        {observedAtMs:NOW-16000},{observedAtMs:NOW+1000},
        {provider:"other"},{network:"mainnet"},{status:"inactive"},
        {codeHash:"a".repeat(64)}, {tipLt:"0"}
    ]) {
        assert.throws(()=>verifyProtectedRefundV4Authorization({
            ...params,snapshots:[snapshot("tonapi",changed),params.snapshots[1]]
        }));
    }
    assert.throws(()=>verifyProtectedRefundV4Authorization({...params,snapshots:[params.snapshots[0]]}),
        {code:"PREFLIGHT_TWO_SOURCES_REQUIRED"});
});
test("same signed BOC never accepts a new seqno or insufficient account balance",()=>{
    const {params,snapshot}=fx();
    const stale=[snapshot("tonapi",{seqno:8}),snapshot("toncenter-v3",{seqno:8})];
    assert.throws(()=>verifyProtectedRefundV4Authorization({...params,snapshots:stale}),
        {code:"PREFLIGHT_SEQNO_MISMATCH"});
    const poor=[snapshot("tonapi",{balanceAtomic:"500000000"}),snapshot("toncenter-v3",{balanceAtomic:"500000000"})];
    assert.throws(()=>verifyProtectedRefundV4Authorization({...params,snapshots:poor}),
        {code:"PREFLIGHT_INSUFFICIENT_BALANCE"});
});
test("different Ed25519 key controls a different wallet and cannot impersonate room",()=>{
    const {params}=fx();
    const second=fx();
    const snapshots=params.snapshots.map(s=>({
        ...s, publicKeyHex:second.params.snapshots[0].publicKeyHex
    }));
    assert.throws(()=>verifyProtectedRefundV4Authorization({...params,snapshots}),
        {code:"PREFLIGHT_PUBLIC_KEY_WALLET_MISMATCH"});
});
test("wrong recipient, amount or tampered BOC fails structural guard before cryptographic claims",()=>{
    const {params}=fx();
    assert.throws(()=>verifyProtectedRefundV4Authorization({...params,toWallet:"0:"+"c".repeat(64)}),
        {code:"BOC_RECIPIENT_AMOUNT_MISMATCH"});
    assert.throws(()=>verifyProtectedRefundV4Authorization({...params,netAtomic:NET-1}),
        {code:"BOC_RECIPIENT_AMOUNT_MISMATCH"});
    assert.throws(()=>verifyProtectedRefundV4Authorization({...params,bocBase64:params.bocBase64.slice(0,-1)+"A"}));
});
test("cryptographic preflight remains read-only despite valid genuine signature",()=>{
    const r=verifyProtectedRefundV4Authorization(fx().params);
    assert.equal(r.refundCompleteAuthorized,false);
    assert.equal(r.walletReleaseAuthorized,false);
    assert.equal(r.broadcastAuthorized,false);
    assert.equal(typeof r.sign,"undefined");
});
