import { canonicalizeTonWalletAddress } from "../../models/TonWalletAddress.js";

export function toNanoAmount(value) {
    if (typeof value === "bigint") {
        return value;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        return BigInt(Math.round(value));
    }

    if (typeof value === "string" && value.trim() !== "") {
        return BigInt(value.trim());
    }

    if (value && typeof value === "object") {
        if (value.amountNano != null) {
            return toNanoAmount(value.amountNano);
        }
        if (value.value != null) {
            return toNanoAmount(value.value);
        }
    }

    return null;
}

export function extractTxHash(tx) {
    return String(
        tx?.transaction_id?.hash
        ?? tx?.hash
        ?? tx?.txHash
        ?? ""
    ).trim() || null;
}

export function extractTxLt(tx) {
    const raw = tx?.transaction_id?.lt ?? tx?.lt ?? null;
    if (raw == null || raw === "") {
        return null;
    }
    try {
        return BigInt(raw);
    } catch {
        return null;
    }
}

export function extractTxUtime(tx) {
    const value = Number(tx?.utime ?? tx?.now ?? 0);
    return Number.isFinite(value) ? value : 0;
}

function msgDestination(msg) {
    return msg?.destination?.address
        ?? msg?.destination
        ?? msg?.dest
        ?? null;
}

function msgSource(msg) {
    return msg?.source?.address
        ?? msg?.source
        ?? null;
}

function outMessages(tx) {
    const outs = tx?.out_msgs ?? tx?.outMessages ?? [];
    return Array.isArray(outs) ? outs : [];
}

export function extractOutboundTransfers(tx) {
    const hash = extractTxHash(tx);
    const utime = extractTxUtime(tx);
    const lt = extractTxLt(tx);
    const success = tx?.success !== false && tx?.aborted !== true;
    const transfers = [];

    for (const msg of outMessages(tx)) {
        const rawDestination = msgDestination(msg);
        const destination = canonicalizeTonWalletAddress(rawDestination)
            ?? (String(rawDestination ?? "").trim() || null);
        const amountNano = toNanoAmount(msg?.value ?? msg?.amount);
        const bounced = msg?.bounced === true;
        if (!destination || amountNano == null) {
            continue;
        }
        transfers.push(Object.freeze({
            hash,
            lt: lt == null ? null : String(lt),
            utime,
            destination,
            amountNano,
            success,
            bounced: bounced === true
        }));
    }

    return Object.freeze(transfers);
}

export function extractInbound(tx) {
    const inMsg = tx?.in_msg ?? tx?.inMessage ?? null;
    if (!inMsg) {
        return null;
    }

    const amountNano = toNanoAmount(inMsg.value ?? inMsg.amount);
    return Object.freeze({
        hash: extractTxHash(tx),
        lt: extractTxLt(tx) == null ? null : String(extractTxLt(tx)),
        utime: extractTxUtime(tx),
        source: canonicalizeTonWalletAddress(msgSource(inMsg)) ?? msgSource(inMsg),
        amountNano,
        bounced: inMsg.bounced === true,
        success: tx?.success !== false && tx?.aborted !== true
    });
}

export function isLaterThanCutoff(tx, cutoffLt, cutoffUtime) {
    const lt = extractTxLt(tx);
    if (lt != null && cutoffLt != null) {
        return lt > cutoffLt;
    }
    return extractTxUtime(tx) > Number(cutoffUtime ?? 0);
}

export async function inspectRoomWalletHistory({
    tonService,
    roomWalletAddress,
    cutoffLt,
    cutoffUtime,
    winnerWallet,
    ownerWallet,
    winnerAmountNano,
    ownerAmountNano
}) {
    const address = String(roomWalletAddress ?? "").trim();
    const [balanceRaw, transactions] = await Promise.all([
        tonService.getBalance(address),
        tonService.getTransactions(address, { limit: 40, archival: true })
    ]);

    let seqno = null;
    if (typeof tonService.getSeqno === "function") {
        seqno = await tonService.getSeqno(address);
    }

    const cutoff = cutoffLt == null ? null : BigInt(cutoffLt);
    const winnerCanon = canonicalizeTonWalletAddress(winnerWallet);
    const ownerCanon = canonicalizeTonWalletAddress(ownerWallet);
    const later = [];
    const winnerMatches = [];
    const ownerMatches = [];

    for (const tx of transactions ?? []) {
        if (!isLaterThanCutoff(tx, cutoff, cutoffUtime)) {
            continue;
        }
        later.push(tx);
        for (const transfer of extractOutboundTransfers(tx)) {
            if (
                transfer.amountNano === winnerAmountNano
                && canonicalizeTonWalletAddress(transfer.destination) === winnerCanon
                && transfer.success
                && transfer.bounced !== true
            ) {
                winnerMatches.push(transfer);
            }
            if (
                transfer.amountNano === ownerAmountNano
                && canonicalizeTonWalletAddress(transfer.destination) === ownerCanon
                && transfer.success
                && transfer.bounced !== true
            ) {
                ownerMatches.push(transfer);
            }
        }
    }

    const laterNonRecovery = later.filter((tx) => {
        const transfers = extractOutboundTransfers(tx);
        if (transfers.length === 0) {
            const inbound = extractInbound(tx);
            return inbound?.amountNano != null && inbound.amountNano > 0n && inbound.bounced !== true;
        }
        return !transfers.every((transfer) => (
            (
                transfer.amountNano === winnerAmountNano
                && canonicalizeTonWalletAddress(transfer.destination) === winnerCanon
            )
            || (
                transfer.amountNano === ownerAmountNano
                && canonicalizeTonWalletAddress(transfer.destination) === ownerCanon
            )
        ));
    });

    return Object.freeze({
        balanceNano: toNanoAmount(balanceRaw),
        seqno,
        laterCount: later.length,
        reused: laterNonRecovery.length > 0,
        winnerPayout: winnerMatches[0] ?? null,
        ownerPayout: ownerMatches[0] ?? null,
        winnerPayoutCount: winnerMatches.length,
        ownerPayoutCount: ownerMatches.length
    });
}

export async function confirmPayoutOnChain({
    tonService,
    roomWalletAddress,
    expectedHash,
    destination,
    amountNano,
    timeoutMs = 90_000,
    pollIntervalMs = 2_000,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
    const deadline = now() + timeoutMs;
    const expected = String(expectedHash ?? "").toLowerCase();
    const destCanon = canonicalizeTonWalletAddress(destination);

    while (now() < deadline) {
        const transactions = await tonService.getTransactions(
            roomWalletAddress,
            { limit: 20, archival: true }
        );
        for (const tx of transactions ?? []) {
            const hash = extractTxHash(tx);
            if (expected && String(hash ?? "").toLowerCase() !== expected) {
                continue;
            }
            for (const transfer of extractOutboundTransfers(tx)) {
                const matchDest = canonicalizeTonWalletAddress(transfer.destination) === destCanon;
                const matchAmount = transfer.amountNano === amountNano;
                if (matchDest && matchAmount && transfer.success && transfer.bounced !== true) {
                    return Object.freeze({
                        ok: true,
                        hash: transfer.hash,
                        amountNano: transfer.amountNano,
                        destination: transfer.destination,
                        utime: transfer.utime
                    });
                }
            }
        }
        await sleep(pollIntervalMs);
    }

    return Object.freeze({
        ok: false,
        code: "PAYOUT_NOT_CONFIRMED",
        hash: expectedHash ?? null
    });
}
