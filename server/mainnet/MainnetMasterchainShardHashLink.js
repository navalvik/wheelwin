/**
 * Mainnet 6B-B: inspect the Basechain shard descriptor INSIDE a complete
 * masterchain block that has already matched a caller-supplied checkpoint.
 *
 * TON block.tlb: Block.extra -> BlockExtra.custom -> McBlockExtra.shard_hashes
 * (HashmapE 32 ^(BinTree ShardDescr)).
 *
 * IMPORTANT: the checkpoint is NOT independently authenticated. An attacker
 * can create both the input block and its alleged root hash. Therefore even
 * a matched descriptor NEVER authorizes payment settlement, Page5 or payouts.
 * No proof validation, signer, network, polling, app wiring or file writes.
 */
import { Cell, Dictionary } from "@ton/core";
import { parseTonAddress } from "../payment/incoming/TonAddressIdentity.js";
import {
    inspectMainnetMasterchainHeaderCheckpoint
} from "./MainnetMasterchainHeaderCheckpoint.js";

const MAX_BLOCK_BOC_BYTES = 524288;
const MAX_SHARD_PATH_DEPTH = 60;
const MAINNET_BASECHAIN = 0;

function blocked(reason) {
    return Object.freeze({
        network: "mainnet",
        status: "BLOCKED",
        reason,
        masterchainHeaderMatched: false,
        shardDescriptorMatched: false,
        independentlyAuthenticatedCheckpoint: false,
        validatorSignaturesVerified: false,
        shardInclusionProofVerified: false,
        transactionInclusionProofVerified: false,
        cryptographicProofVerified: false,
        settlementAuthorized: false,
        gameStartAuthorized: false
    });
}
function hash(value) {
    return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value)
        ? value.toLowerCase() : null;
}
function fullBlock(data) {
    if (typeof data !== "string" || !data.length
        || data.length > Math.ceil(MAX_BLOCK_BOC_BYTES * 4 / 3) + 4
        || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(data)) return null;
    try {
        const bytes = Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
        if (!bytes.length || bytes.length > MAX_BLOCK_BOC_BYTES) return null;
        const roots = Cell.fromBoc(bytes);
        return roots.length === 1 && !roots[0].isExotic ? roots[0] : null;
    } catch {
        return null;
    }
}
function walletBits(address) {
    try {
        const parsed = parseTonAddress(address);
        if (parsed.workchain !== MAINNET_BASECHAIN || parsed.testOnly === true)
            return null;
        const raw = parsed.identity.split(":")[1];
        if (!/^[0-9a-f]{64}$/.test(raw)) return null;
        return BigInt("0x" + raw);
    } catch {
        return null;
    }
}
function loadShardHashTree(root) {
    // Never accept missing paths, exotic data or wrong TL-B constructors.
    const s = root.beginParse();
    if (s.loadUint(32) !== 0x11ef55aa || s.loadInt(32) !== -239
        || s.remainingRefs !== 4 || s.remainingBits !== 0)
        throw new Error("BLOCK_LAYOUT_INVALID");
    s.loadRef(); // BlockInfo independently inspected in prior step.
    s.loadRef(); // ValueFlow not interpreted here.
    s.loadRef(); // MerkleUpdate not interpreted here.
    const extraCell = s.loadRef();
    if (extraCell.isExotic) throw new Error("BLOCK_EXTRA_EXOTIC");
    const extra = extraCell.beginParse();
    if (extra.loadUint(32) !== 0x4a33f6fd || extra.remainingRefs !== 3 && extra.remainingRefs !== 4)
        throw new Error("BLOCK_EXTRA_INVALID");
    extra.loadRef(); // InMsgDescr.
    extra.loadRef(); // OutMsgDescr.
    extra.loadRef(); // ShardAccountBlocks.
    extra.loadBuffer(32); // rand_seed
    extra.loadBuffer(32); // created_by
    if (!extra.loadBit() || extra.remainingBits !== 0 || extra.remainingRefs !== 1)
        throw new Error("MASTERCHAIN_CUSTOM_MISSING");
    const custom = extra.loadRef();
    if (custom.isExotic) throw new Error("MASTERCHAIN_EXTRA_EXOTIC");
    const mc = custom.beginParse();
    if (mc.loadUint(16) !== 0xcca5) throw new Error("MASTERCHAIN_EXTRA_INVALID");
    mc.loadBit(); // key_block: no settlement trust implied.
    const dict = mc.loadDict(Dictionary.Keys.Int(32), Dictionary.Values.Cell());
    if (!dict || !dict.has(MAINNET_BASECHAIN))
        throw new Error("BASECHAIN_SHARDS_MISSING");
    const tree = dict.get(MAINNET_BASECHAIN);
    if (!tree || tree.isExotic) throw new Error("BASECHAIN_TREE_INVALID");
    return tree;
}

function shardForPrefix(prefix, depth) {
    const lead = prefix << BigInt(64 - depth);
    const marker = 1n << BigInt(63 - depth);
    return (lead | marker).toString(16).padStart(16, "0");
}
function readCurrencyCollection(slice) {
    slice.loadCoins();
    // ExtraCurrencyCollection = HashmapE 32 (VarUInteger 32).
    // The VarUInteger 32 length prefix is 5 bits.
    slice.loadDict(Dictionary.Keys.Uint(32), Dictionary.Values.BigVarUint(5));
}
function readShardDescriptorTail(slice, tag) {
    // Both TL-B variants share the same flags and routing fields.
    for (let i=0; i<5; i+=1) slice.loadBit();
    if (slice.loadUint(3) !== 0) throw new Error("SHARD_FLAGS_NONZERO");
    slice.loadUint(32); // next_catchain_seqno
    slice.loadUintBig(64); // next_validator_shard
    slice.loadUint(32); // min_ref_mc_seqno
    if (slice.loadUint(32) <= 0) throw new Error("SHARD_GEN_TIME_INVALID");
    // FutureSplitMerge: none$0, split$10, merge$11.
    if (slice.loadBit()) {
        slice.loadBit();
        slice.loadUint(32);
        slice.loadUint(32);
    }
    if (tag === 0xb) {
        readCurrencyCollection(slice);
        readCurrencyCollection(slice);
    } else {
        // shard_descr_new#a contains fees in a separate reference.
        if (slice.remainingRefs !== 1)
            throw new Error("SHARD_FEES_REF_MISSING");
        const feeCell = slice.loadRef();
        if (feeCell.isExotic) throw new Error("SHARD_FEES_EXOTIC");
        const fees = feeCell.beginParse();
        readCurrencyCollection(fees);
        readCurrencyCollection(fees);
        if (fees.remainingBits !== 0 || fees.remainingRefs !== 0)
            throw new Error("SHARD_FEES_TRAILING_DATA");
    }
    if (slice.remainingBits !== 0 || slice.remainingRefs !== 0)
        throw new Error("SHARD_DESCRIPTOR_TRAILING_DATA");
}
function findShardDescriptor(tree, addressHash, masterchainSeqno) {
    let node = tree;
    let prefix = 0n;
    for (let depth = 0; depth <= MAX_SHARD_PATH_DEPTH; depth += 1) {
        if (node.isExotic) throw new Error("EXOTIC_SHARD_TREE");
        const s = node.beginParse();
        if (!s.loadBit()) {
            // bt_leaf$0 leaf:ShardDescr; old and new ShardDescr both start
            // with 4-bit TL-B constructor and share this prefix.
            const tag = s.loadUint(4);
            if (tag !== 0xb && tag !== 0xa)
                throw new Error("SHARD_DESCRIPTOR_TAG_INVALID");
            const seqno = s.loadUint(32);
            const regMcSeqno = s.loadUint(32);
            const startLt = s.loadUintBig(64);
            const endLt = s.loadUintBig(64);
            const rootHash = s.loadBuffer(32).toString("hex");
            const fileHash = s.loadBuffer(32).toString("hex");
            if (seqno < 1 || regMcSeqno < 1
                || regMcSeqno > masterchainSeqno
                || startLt <= 0n || endLt <= startLt
                || rootHash === "0".repeat(64)
                || fileHash === "0".repeat(64)) {
                throw new Error("SHARD_DESCRIPTOR_INVALID");
            }
            readShardDescriptorTail(s,tag);
            return {seqno, regMcSeqno, rootHash, fileHash,
                shard: shardForPrefix(prefix, depth), depth};
        }
        if (depth === MAX_SHARD_PATH_DEPTH
            || s.remainingBits !== 0 || s.remainingRefs !== 2)
            throw new Error("SHARD_TREE_FORK_INVALID");
        const side = Number((addressHash >> BigInt(255 - depth)) & 1n);
        const left = s.loadRef();
        const right = s.loadRef();
        node = side === 0 ? left : right;
        prefix = (prefix << 1n) | BigInt(side);
    }
    throw new Error("SHARD_TREE_DEPTH_EXCEEDED");
}

/**
 * Compare a shard root hash against a workchain-0 ShardDescr reachable
 * through the wallet's address bits from a complete masterchain block.
 * The caller-provided checkpoint MUST be authenticated in a future release:
 * this inspection alone establishes no consensus or tx inclusion.
 */
export function inspectMainnetShardHashLink({
    checkpoint, masterchainBlockBocBase64, walletAddress, shardBlock
} = {}) {
    const address = walletBits(walletAddress);
    if (address === null || !shardBlock || typeof shardBlock !== "object"
        || Array.isArray(shardBlock)
        || shardBlock.workchain !== MAINNET_BASECHAIN
        || typeof shardBlock.shard !== "string"
        || !/^[0-9a-fA-F]{16}$/.test(shardBlock.shard)
        || !Number.isSafeInteger(shardBlock.seqno) || shardBlock.seqno < 1
        || !hash(shardBlock.rootHash)) {
        return blocked("SHARD_LINK_INPUT_INVALID");
    }

    const header = inspectMainnetMasterchainHeaderCheckpoint({
        checkpoint, masterchainBlockBocBase64
    });
    if (header.status !== "MASTERCHAIN_HEADER_MATCHES_SUPPLIED_CHECKPOINT")
        return blocked(header.reason);

    const root = fullBlock(masterchainBlockBocBase64);
    if (!root) return blocked("MASTERCHAIN_BLOCK_BOC_INVALID");
    let descriptor;
    try {
        descriptor = findShardDescriptor(loadShardHashTree(root), address, checkpoint.seqno);
    } catch {
        return blocked("MASTERCHAIN_SHARD_STRUCTURE_INVALID");
    }
    if (descriptor.shard !== shardBlock.shard.toLowerCase()
        || descriptor.seqno !== shardBlock.seqno
        || descriptor.rootHash !== shardBlock.rootHash.toLowerCase()) {
        return blocked("SHARD_DESCRIPTOR_REFERENCE_MISMATCH");
    }

    // Descriptor comparison uses content belonging to the supplied full
    // block BOC, but there is no independently verified consensus root.
    return Object.freeze({
        network: "mainnet",
        status: "SHARD_HASH_MATCHES_UNAUTHENTICATED_MASTERCHAIN_BLOCK",
        reason: "VALIDATOR_CHECKPOINT_AND_TRANSACTION_INCLUSION_REQUIRED",
        masterchainHeaderMatched: true,
        shardDescriptorMatched: true,
        shardDepth: descriptor.depth,
        shard: descriptor.shard,
        shardSeqno: descriptor.seqno,
        shardRootHash: descriptor.rootHash,
        independentlyAuthenticatedCheckpoint: false,
        validatorSignaturesVerified: false,
        shardInclusionProofVerified: false,
        transactionInclusionProofVerified: false,
        cryptographicProofVerified: false,
        settlementAuthorized: false,
        gameStartAuthorized: false
    });
}
