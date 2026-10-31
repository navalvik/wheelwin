import test from "node:test";
import assert from "node:assert/strict";
import {Address, beginCell, Cell, Dictionary, storeShardIdent} from "@ton/core";
import {
    inspectMainnetShardHashLink
} from "../mainnet/MainnetMasterchainShardHashLink.js";

const MASTER = "-9223372036854775808";
const SEQNO = 120046;
const ROOT_SHARD = "8000000000000000";
const LEFT_SHARD = "4000000000000000";
const RIGHT_SHARD = "c000000000000000";
const WALLET_LEFT = "0:" + "0".repeat(64);
const WALLET_RIGHT = "0:" + "f".repeat(64);
const ROOT_HASH = "ab".repeat(32);
const ALT_HASH = "cd".repeat(32);
function stateUpdate() {
    const before = beginCell().storeUint(1,8).endCell();
    const after = beginCell().storeUint(2,8).endCell();
    return beginCell().storeUint(4,8)
        .storeBuffer(before.hash()).storeBuffer(after.hash())
        .storeUint(before.depth(),16).storeUint(after.depth(),16)
        .storeRef(before).storeRef(after).endCell({exotic:true});
}
function shardDescriptor(rootHash = ROOT_HASH,{seqno = 5500,tag = 0xb,badTrailing=false} = {}) {
    // ShardDescr TL-B old (#b) and new (#a) variants.
    const builder=beginCell().storeBit(false).storeUint(tag,4)
        .storeUint(seqno,32).storeUint(120040,32)
        .storeUint(10n,64).storeUint(20n,64)
        .storeBuffer(Buffer.from(rootHash,"hex"))
        .storeBuffer(Buffer.alloc(32,5))
        .storeBit(false).storeBit(false)
        .storeBit(false).storeBit(false).storeBit(false)
        .storeUint(0,3).storeUint(1,32).storeUint(0n,64)
        .storeUint(100,32).storeUint(1793451600,32)
        .storeBit(false); // FutureSplitMerge none
    if(tag===0xa) {
        builder.storeRef(beginCell()
            .storeCoins(0n).storeBit(false)
            .storeCoins(0n).storeBit(false).endCell());
    } else {
        builder.storeCoins(0n).storeBit(false)
            .storeCoins(0n).storeBit(false);
    }
    if(badTrailing) builder.storeBit(true);
    return builder.endCell();
}
function fixture({
    fork = false, rootHash = ROOT_HASH, leftHash = ROOT_HASH,
    rightHash = ALT_HASH, shardSeqno=5500, basechain=true,
    custom=true, badExtra=false, invalidTag=false, missingDict=false,
    descriptorTag=0xb,badTrailing=false
} = {}) {
    const previous=beginCell().storeUint(9n,64).storeUint(SEQNO-1,32)
        .storeBuffer(Buffer.alloc(32,1)).storeBuffer(Buffer.alloc(32,2))
        .endCell();
    const info=beginCell().storeUint(0x9bc7a987,32)
        .storeUint(0,32)
        .storeBit(false).storeBit(false).storeBit(false).storeBit(false)
        .storeBit(false).storeBit(false).storeBit(false).storeBit(false)
        .storeUint(0,8).storeUint(SEQNO,32).storeUint(0,32)
        .store(storeShardIdent({shardPrefixBits:0,workchainId:-1,
            shardPrefix:0x8000000000000000n}))
        .storeUint(1793451600,32).storeUint(20n,64).storeUint(30n,64)
        .storeUint(0,32).storeUint(0,32).storeUint(1,32).storeUint(1,32)
        .storeRef(previous).endCell();
    const left=shardDescriptor(leftHash,{seqno:shardSeqno,tag:invalidTag?0x9:descriptorTag,badTrailing});
    const right=shardDescriptor(rightHash,{seqno:shardSeqno});
    const tree=fork
        ? beginCell().storeBit(true).storeRef(left).storeRef(right).endCell()
        : shardDescriptor(rootHash,{seqno:shardSeqno,tag:invalidTag?0x9:descriptorTag,badTrailing});
    const dict=Dictionary.empty(Dictionary.Keys.Int(32),Dictionary.Values.Cell());
    if(basechain && !missingDict) dict.set(0,tree);
    else if(!missingDict) dict.set(-1,tree);
    const mcExtra=beginCell().storeUint(0xcca5,16).storeBit(false)
        .storeDict(dict)
        .storeBit(false) // shard fees empty
        .storeRef(beginCell().storeBit(false).storeBit(false)
            .storeBit(false).endCell())
        .endCell();
    const extraBuilder=beginCell()
        .storeUint(badExtra?0x12345678:0x4a33f6fd,32)
        .storeBuffer(Buffer.alloc(32,10))
        .storeBuffer(Buffer.alloc(32,11))
        .storeBit(custom)
        .storeRef(Cell.EMPTY).storeRef(Cell.EMPTY).storeRef(Cell.EMPTY);
    if(custom) extraBuilder.storeRef(mcExtra);
    const block=beginCell().storeUint(0x11ef55aa,32).storeInt(-239,32)
        .storeRef(info).storeRef(Cell.EMPTY).storeRef(stateUpdate())
        .storeRef(extraBuilder.endCell()).endCell();
    return {block,boc:block.toBoc().toString("base64"),checkpoint:{
        network:"mainnet",globalId:-239,workchain:-1,
        shard:MASTER,seqno:SEQNO,rootHash:block.hash().toString("hex")
    }};
}
function inspect(f, opts={}) {
    return inspectMainnetShardHashLink({
        checkpoint:f.checkpoint,masterchainBlockBocBase64:f.boc,
        walletAddress:WALLET_LEFT,
        shardBlock:{workchain:0,shard:ROOT_SHARD,seqno:5500,rootHash:ROOT_HASH},
        ...opts
    });
}
function checkSafety(r) {
    for(const key of ["independentlyAuthenticatedCheckpoint",
        "validatorSignaturesVerified","shardInclusionProofVerified",
        "transactionInclusionProofVerified","cryptographicProofVerified",
        "settlementAuthorized","gameStartAuthorized"]) assert.equal(r[key],false,key);
}

test("complete masterchain block yields wallet-specific shard root, but zero settlement authority",()=>{
    const r=inspect(fixture());
    assert.equal(r.status,"SHARD_HASH_MATCHES_UNAUTHENTICATED_MASTERCHAIN_BLOCK");
    assert.equal(r.shardDescriptorMatched,true);
    assert.equal(r.masterchainHeaderMatched,true);
    assert.equal(r.shardDepth,0);
    assert.equal(r.shardRootHash,ROOT_HASH);
    assert.equal(r.shard,ROOT_SHARD);
    assert.equal(r.shardSeqno,5500);
    checkSafety(r);
});

test("split basechain selects left/right shard by first address bit",()=>{
    const f=fixture({fork:true});
    for(const [address,shard,rootHash] of [
        [WALLET_LEFT,LEFT_SHARD,ROOT_HASH],
        [WALLET_RIGHT,RIGHT_SHARD,ALT_HASH]
    ]) {
        const r=inspect(f,{walletAddress:address,
            shardBlock:{workchain:0,shard,seqno:5500,rootHash}});
        assert.equal(r.status,"SHARD_HASH_MATCHES_UNAUTHENTICATED_MASTERCHAIN_BLOCK");
        assert.equal(r.shardDepth,1);
        assert.equal(r.shard,shard);
        checkSafety(r);
    }
});

test("wrong shard root, seqno or selected path cannot be misreported as included",()=>{
    const f=fixture({fork:true});
    for(const shardBlock of [
        {workchain:0,shard:LEFT_SHARD,seqno:5500,rootHash:ALT_HASH},
        {workchain:0,shard:LEFT_SHARD,seqno:5501,rootHash:ROOT_HASH},
        {workchain:0,shard:ROOT_SHARD,seqno:5500,rootHash:ROOT_HASH},
        {workchain:0,shard:RIGHT_SHARD,seqno:5500,rootHash:ALT_HASH}
    ]) {
        const r=inspect(f,{shardBlock});
        assert.equal(r.reason,"SHARD_DESCRIPTOR_REFERENCE_MISMATCH");
        checkSafety(r);
    }
});

test("invalid account/network, malformed BOC, checkpoint and shard claims fail closed",()=>{
    const f=fixture();
    for(const overrides of [
        {walletAddress:"0:not-a-wallet"},
        {walletAddress:Address.parse(WALLET_LEFT).toString({testOnly:true})},
        {shardBlock:{workchain:-1,shard:ROOT_SHARD,seqno:5500,rootHash:ROOT_HASH}},
        {shardBlock:{workchain:0,shard:ROOT_SHARD,seqno:0,rootHash:ROOT_HASH}},
        {shardBlock:{workchain:0,shard:ROOT_SHARD,seqno:5500,rootHash:"0x123"}},
        {checkpoint:{...f.checkpoint,globalId:-3}},
        {masterchainBlockBocBase64:"garbage"}
    ]) {
        const r=inspect(f,overrides);
        assert.equal(r.status,"BLOCKED");
        checkSafety(r);
    }
});

test("missing McBlockExtra, wrong tag, absent basechain and invalid shard descriptor refuse",()=>{
    for(const overrides of [
        {custom:false},{badExtra:true},{basechain:false},
        {invalidTag:true},{missingDict:true}
    ]) {
        const r=inspect(fixture(overrides));
        assert.equal(r.reason,"MASTERCHAIN_SHARD_STRUCTURE_INVALID",
            JSON.stringify(overrides));
        checkSafety(r);
    }
});

test("caller can invent a matching checkpoint; descriptor match is NOT cryptographic consensus",()=>{
    const f=fixture({rootHash:"ff".repeat(32)});
    const r=inspect(f,{shardBlock:{
        workchain:0,shard:ROOT_SHARD,seqno:5500,rootHash:"ff".repeat(32)
    }});
    assert.equal(r.status,"SHARD_HASH_MATCHES_UNAUTHENTICATED_MASTERCHAIN_BLOCK");
    assert.equal(r.shardDescriptorMatched,true);
    checkSafety(r);
});

test("a different valid block cannot be substituted under a supplied checkpoint",()=>{
    const f=fixture();
    const g=fixture({rootHash:ALT_HASH});
    const r=inspect(f,{masterchainBlockBocBase64:g.boc});
    assert.equal(r.reason,"MASTERCHAIN_BLOCK_ROOT_HASH_MISMATCH");
    checkSafety(r);
});


test("new TL-B shard_descr_new#a variant with fee ref is accepted without auth",()=>{
    const r=inspect(fixture({descriptorTag:0xa}));
    assert.equal(r.status,"SHARD_HASH_MATCHES_UNAUTHENTICATED_MASTERCHAIN_BLOCK");
    checkSafety(r);
});

test("new descriptor variant in a split tree selects the wallet's left shard",()=>{
    const f=fixture({descriptorTag:0xa, fork:true});
    const r=inspect(f,{shardBlock:{
        workchain:0,shard:LEFT_SHARD,seqno:5500,rootHash:ROOT_HASH
    }});
    assert.equal(r.status,"SHARD_HASH_MATCHES_UNAUTHENTICATED_MASTERCHAIN_BLOCK");
    assert.equal(r.shard,LEFT_SHARD);
    checkSafety(r);
});

test("extra bits after complete old/new shard descriptor fail closed",()=>{
    for(const descriptorTag of [0xb,0xa]) {
        const r=inspect(fixture({descriptorTag,badTrailing:true}));
        assert.equal(r.reason,"MASTERCHAIN_SHARD_STRUCTURE_INVALID");
        checkSafety(r);
    }
});
