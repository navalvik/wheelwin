import { durableWriteJson } from '../payment/DurableJson.js';
import {
    createWriteStream,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    writeFileSync
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import archiver from "archiver";

import { safeFilenameSegment } from "./forensicArchiveNaming.js";
import { tonAddressIdentitiesEqual } from "../payment/incoming/TonAddressIdentity.js";

/**
 * R13.9F — Collect existing forensic artifacts byte-for-byte into a ZIP.
 * Does not parse, filter, or rewrite source JSON/log files.\n * The retired financial record subsystem is deliberately NOT imported.
 */
export class ForensicArchiveCollector {

    constructor({
        sessionHistoryDir,
        diagnosticLogsDir,
        sessionHistoryArchive = null,
        financialSnapshotProvider = null,
        gameReportEngine = null
    }) {

        this._sessionHistoryDir = sessionHistoryDir;
        this._diagnosticLogsDir = diagnosticLogsDir;
        this._sessionHistoryArchive = sessionHistoryArchive;
        this._gameReportEngine = gameReportEngine;
        this._financialSnapshotProvider = financialSnapshotProvider;

    }

    /**
     * @returns {Promise<{
     *   zipPath: string,
     *   archiveFilename: string,
     *   files: Array<{ sourcePath: string, zipPath: string, sha256: string }>
     * }>}
     */
    async collectToZip({
        roomId,
        gameId = null,
        reason = "room_destroyed",
        zipPath,
        archiveFilename,
        financialSnapshot
    }) {

        this._sessionHistoryArchive?.finalizeIfPending?.({
            roomId,
            gameId,
            reason
        });

        const entries = this._discoverArtifactEntries({ roomId, gameId, financialSnapshot });

        if (entries.length === 0) {

            throw new Error(
                `No forensic artifacts found | roomId=${roomId}`
            );

        }

        mkdirSync(join(zipPath, ".."), { recursive: true });

        const fileManifest = [];

        await this._writeZip({
            zipPath,
            entries,
            onFileAdded(sourcePath, zipEntryPath, sha256) {

                fileManifest.push({
                    sourcePath,
                    zipPath: zipEntryPath,
                    sha256
                });

            }
        });

        return {
            zipPath,
            archiveFilename,
            files: fileManifest
        };

    }

    _discoverArtifactEntries({ roomId, gameId, financialSnapshot }) {

        const entries = [];
        const finance = financialSnapshot ?? this._financialSnapshotProvider?.(roomId);
        if (finance) {
            const roomWallet = buildRoomWalletRecord(finance);
            const decisions = buildPaymentDecisions(finance);
            const recovery = buildFinancialRecovery(finance);
            const finalReport = buildFinalFinancialReport(finance, decisions, recovery);
            entries.push({inlineContent: JSON.stringify(roomWallet, null, 2) + '\n', zipPath: 'financial/room-wallet.json'});
            entries.push({inlineContent: JSON.stringify({schemaVersion:1, roomId, events: finance.paymentObservations ?? []}, null, 2) + '\n', zipPath:'forensics/payment-observations.json'});
            entries.push({inlineContent: JSON.stringify({schemaVersion:1, roomId, decisions}, null, 2) + '\n', zipPath:'forensics/payment-decisions.json'});
            entries.push({inlineContent: JSON.stringify(recovery, null, 2) + '\n', zipPath:'forensics/financial-recovery.json'});
            entries.push({inlineContent: JSON.stringify(finalReport, null, 2) + '\n', zipPath:'financial/final-report.json'});
            if (finance.archiveLineage) entries.push({inlineContent: JSON.stringify(finance.archiveLineage, null, 2) + '\n', zipPath:'forensics/archive-lineage.json'});
        }
        const seenSources = new Set();

        const pushEntry = (sourcePath, zipPath) => {

            if (!sourcePath || !existsSync(sourcePath)) {

                return;

            }

            const normalized = sourcePath.toLowerCase();

            if (seenSources.has(normalized)) {

                return;

            }

            seenSources.add(normalized);

            entries.push({
                sourcePath,
                zipPath
            });

        };

        const sessionHistoryFiles = this._discoverSessionHistoryFiles(roomId);
        for (const file of sessionHistoryFiles) {

            pushEntry(
                file.absolutePath,
                join("session-history", file.filename)
            );

        }

        const roomMode = sessionHistoryFiles
            .map((file) => {
                try {
                    const record = JSON.parse(readFileSync(file.absolutePath, "utf8"));
                    return record?.configuration?.room?.gameMode
                        ?? record?.finalSnapshot?.room?.gameMode
                        ?? null;
                } catch {
                    return null;
                }
            })
            .find((mode) => mode === "NO_FRIENDS" || mode === "FRIENDS") ?? "UNKNOWN";
        entries.push({
            inlineContent: JSON.stringify({
                schemaVersion: 1,
                roomId,
                gameId: gameId ?? null,
                gameMode: roomMode,
                displayMode: roomMode === "NO_FRIENDS"
                    ? "I HAVE NO FRIENDS"
                    : roomMode === "FRIENDS" ? "I HAVE FRIENDS" : "UNKNOWN"
            }, null, 2) + "\n",
            zipPath: "session/game-mode.json"
        });

        for (const file of this._discoverDiagnosticLogFiles(roomId)) {

            pushEntry(
                file.absolutePath,
                join("diagnostic-logs", file.filename)
            );

        }

        const gameReport = this._gameReportEngine?.resolveReport?.(gameId)
            ?? this._gameReportEngine?.getReport?.(gameId)
            ?? null;

        if (gameReport) {

            entries.push({
                inlineContent: JSON.stringify(gameReport, null, 2) + "\n",
                zipPath: join(
                    "game-report",
                    `${safeFilenameSegment(gameReport.reportId ?? gameId)}.json`
                )
            });

        }

        return entries;

    }

    _discoverSessionHistoryFiles(roomId) {

        if (this._sessionHistoryArchive?.listRecordFilePathsForRoom) {

            return this._sessionHistoryArchive.listRecordFilePathsForRoom(roomId);

        }

        if (!existsSync(this._sessionHistoryDir)) {

            return [];

        }

        const needle = `_ROOM_${safeFilenameSegment(roomId)}_`;

        return readdirSync(this._sessionHistoryDir)
            .filter((name) => name.endsWith(".json") && name !== "index.json")
            .filter((name) => name.includes(needle))
            .map((filename) => ({
                filename,
                absolutePath: join(this._sessionHistoryDir, filename)
            }));

    }

    _discoverDiagnosticLogFiles(roomId) {

        if (!existsSync(this._diagnosticLogsDir)) {

            return [];

        }

        const needle = `_ROOM_${safeFilenameSegment(roomId)}`;

        return readdirSync(this._diagnosticLogsDir)
            .filter((name) => name.endsWith(".log") && name.includes(needle))
            .map((filename) => ({
                filename,
                absolutePath: join(this._diagnosticLogsDir, filename)
            }));

    }

    async _writeZip({ zipPath, entries, onFileAdded }) {

        await new Promise((resolve, reject) => {

            const output = createWriteStream(zipPath);
            const archive = archiver("zip", { zlib: { level: 9 } });

            output.on("close", resolve);
            output.on("error", reject);
            archive.on("error", reject);

            archive.pipe(output);

            for (const entry of entries) {

                if (entry.inlineContent != null) {

                    const sha256 = createHash("sha256")
                        .update(entry.inlineContent, "utf8")
                        .digest("hex");

                    onFileAdded(
                        "[generated]",
                        entry.zipPath,
                        sha256
                    );

                    archive.append(entry.inlineContent, {
                        name: entry.zipPath
                    });

                    continue;

                }

                const sha256 = this._sha256File(entry.sourcePath);

                onFileAdded(entry.sourcePath, entry.zipPath, sha256);

                archive.file(entry.sourcePath, { name: entry.zipPath });

            }

            archive.finalize();

        });

    }

    _sha256File(filePath) {

        const hash = createHash("sha256");

        hash.update(readFileSync(filePath));

        return hash.digest("hex");

    }

}

function buildRoomWalletRecord(finance) {
    const intents = finance.intents ?? [];
    const receipts = finance.receipts ?? [];
    return {
        ...finance,
        gameId: finance.gameId ?? null,
        playerPayments: intents.map(intent => ({
            playerId:intent.playerId,
            paymentReference:intent.paymentReference,
            expectedAmountAtomic:intent.amountAtomic,
            expectedSenderAddress:intent.expectedSender,
            destinationWalletAddress:intent.destinationWalletAddress,
            network:intent.network,
            asset:intent.asset,
            expiresAt:intent.expiresAt,
            finalState:intent.state,
            transactionId:intent.transactionId ?? null,
            transactions:receipts.filter(receipt => receipt.playerId === intent.playerId
                || receipt.paymentIntentId === intent.paymentReference)
        }))
    };
}

export function buildPaymentDecisions(finance) {
    const intents = finance.intents ?? [];
    const receipts = [...(finance.receipts ?? []), ...(finance.unresolvedReceipts ?? [])];
    const settledTransactions = new Set(intents.filter(i => i.state === "SETTLED").map(i => i.transactionId));
    const seenTransactions = new Set();
    const decisions = [];
    for (const receipt of receipts) {
        if (receipt.transactionId && seenTransactions.has(receipt.transactionId)) {
            decisions.push({at:receipt.transactionTime ?? null, transactionId:receipt.transactionId,
                playerId:receipt.playerId ?? null, paymentReference:receipt.paymentReference ?? null,
                decision:"DUPLICATE", reason:"DUPLICATE_TRANSACTION_ID_IN_DURABLE_RECEIPTS",
                amountAtomic:receipt.amountAtomic, senderAddress:receipt.senderAddress,
                destinationWalletAddress:receipt.destinationWalletAddress});
            continue;
        }
        if (receipt.transactionId) seenTransactions.add(receipt.transactionId);
        const byReference = intents.filter(intent => intent.paymentReference === receipt.paymentReference
            || (!receipt.paymentReference && intent.paymentReference === receipt.paymentIntentId));
        const byPlayer = receipt.playerId ? intents.filter(intent => intent.playerId === receipt.playerId) : [];
        const bySender = intents.filter(intent => addressMatches(intent.expectedSender, receipt.senderAddress));
        const plausibleWithoutReference = !receipt.paymentReference && !byPlayer.length && !bySender.length
            ? intents.filter(intent => addressMatches(intent.destinationWalletAddress, receipt.destinationWalletAddress)
                && intent.amountAtomic === receipt.amountAtomic
                && Number.isSafeInteger(receipt.transactionTime)
                && receipt.transactionTime >= intent.createdAt && receipt.transactionTime < intent.expiresAt)
            : [];
        const candidates = byReference.length ? byReference : byPlayer.length ? byPlayer
            : bySender.length ? bySender : plausibleWithoutReference;
        const owner = candidates.length === 1 ? candidates[0] : null;
        const mismatch = [];
        if (receipt.ownershipStatus === "UNRESOLVED") mismatch.push("AMBIGUOUS");
        else if (candidates.length > 1) mismatch.push("AMBIGUOUS");
        else if (!owner) mismatch.push("UNATTRIBUTED_TRANSFER");
        if (owner) {
            if (!addressMatches(receipt.destinationWalletAddress, owner.destinationWalletAddress)) mismatch.push("DESTINATION_MISMATCH");
            if (!addressMatches(receipt.senderAddress, owner.expectedSender)) mismatch.push("SENDER_MISMATCH");
            if (receipt.amountAtomic !== owner.amountAtomic) mismatch.push("AMOUNT_MISMATCH");
            if (!receipt.paymentReference) mismatch.push("MISSING_REFERENCE");
            else if (receipt.paymentReference !== owner.paymentReference) mismatch.push("REFERENCE_MISMATCH");
            if (!Number.isSafeInteger(receipt.transactionTime)
                || !Number.isSafeInteger(owner.createdAt) || !Number.isSafeInteger(owner.expiresAt)) {
                mismatch.push("UNVERIFIED");
            } else if (receipt.transactionTime < owner.createdAt || receipt.transactionTime >= owner.expiresAt) {
                mismatch.push("LATE_PAYMENT");
            }
        }
        const journalRows = (finance.paymentDecisions ?? []).filter(row => row.transactionId === receipt.transactionId);
        if (!settledTransactions.has(receipt.transactionId)
            && journalRows.some(row => row.decision === "AMBIGUOUS")
            && !mismatch.includes("AMBIGUOUS")) mismatch.unshift("AMBIGUOUS");
        const alreadySettled = settledTransactions.has(receipt.transactionId);
        let decision = alreadySettled ? "SETTLED" : mismatch[0] ?? "PENDING_CONFIRMATION";
        if (alreadySettled) mismatch.length = 0;
        const reason = alreadySettled ? null
            : mismatch.length ? mismatch.join("+") : "SETTLEMENT_NOT_YET_CONFIRMED";
        decisions.push({at:Number.isSafeInteger(receipt.transactionTime) ? receipt.transactionTime : null,
            transactionId:receipt.transactionId ?? null,
            playerId:receipt.playerId ?? owner?.playerId ?? null,
            paymentReference:receipt.paymentReference ?? null, decision, reason,
            mismatchReasons:mismatch,
            amountAtomic:receipt.amountAtomic, senderAddress:receipt.senderAddress,
            destinationWalletAddress:receipt.destinationWalletAddress,
            candidateRoomIds:receipt.candidateRoomIds ?? null,
            unresolvedReason:receipt.unresolvedReason ?? null});
    }
    for (const intent of intents) {
        if (intent.state === "SETTLED" || receipts.some(r => r.paymentIntentId === intent.paymentReference)) continue;
        const latest = (finance.paymentObservations ?? []).at(-1);
        decisions.push({at:latest?.completedAt ?? null, playerId:intent.playerId,
            paymentReference:intent.paymentReference,
            decision:latest?.resultWindowComplete === true ? "NO_MATCH_OBSERVED" : "UNVERIFIED",
            reason:latest?.providerError ?? latest?.skippedReason ?? "NO_CONFIRMED_TRANSFER_FOUND",
            expectedAmountAtomic:intent.amountAtomic, expectedSenderAddress:intent.expectedSender,
            destinationWalletAddress:intent.destinationWalletAddress});
    }
    const receiptTransactionIds = new Set(receipts.map(r => r.transactionId).filter(Boolean));
    for (const item of finance.paymentDecisions ?? []) {
        if (item.transactionId && receiptTransactionIds.has(item.transactionId)) continue;
        if (!item.transactionId && !["UNVERIFIED", "PROVIDER_UNAVAILABLE"].includes(item.decision)) continue;
        decisions.push(item);
    }
    return [...new Map(decisions.map(item => [
        item.transactionId ? `${item.transactionId}:${item.decision}:${item.reason ?? ""}`
            : `event:${item.decision}:${item.reason ?? ""}:${item.at ?? ""}`,
        item
    ])).values()].sort((a,b)=>(a.at ?? 0)-(b.at ?? 0));
}

function addressMatches(left, right) {
    if (!left || !right) return false;
    try { return tonAddressIdentitiesEqual(left, right); } catch { return false; }
}

export function buildFinancialRecovery(finance) {
    const payouts=(finance.ledger ?? []).filter(entry => ["PAYOUT_PLAN", "PAYOUT_SETTLEMENT", "NET_PAYOUT", "WINNER_GROSS_ALLOCATION", "OWNER_GROSS_ALLOCATION"].includes(entry.kind));
    const ledger = finance.ledger ?? [];
    const unresolvedReceipts=finance.unresolvedReceipts ?? [];
    return {schemaVersion:1, roomId:finance.roomId, gameId:finance.gameId ?? null, closedRoom:finance.closedRoom ?? null,
        receipts:finance.receipts ?? [], unresolvedReceipts, refunds:finance.refunds ?? [], payouts,
        outstandingObligations:finance.outstandingObligations ?? 0,
        requiresReconciliation:unresolvedReceipts.length > 0 || (finance.receipts ?? []).some(r => !r.playerId || !r.paymentIntentId)
            || (finance.refunds ?? []).some(r => r.state !== "COMPLETE")
            || payouts.some(p => p.kind === "PAYOUT_PLAN" && !hasPayoutSettlements(p, ledger))};
}

function hasPayoutSettlements(plan, ledger) {
    const payoutId = plan.metadata?.payoutId;
    const settlements = ledger.filter(entry => entry.kind === "PAYOUT_SETTLEMENT"
        && (entry.metadata?.payoutPlanId === plan.entryId
            || (payoutId && entry.metadata?.payoutId === payoutId)));
    if (settlements.length === 0) return false;

    const expectedRoles = (plan.metadata?.plan?.transfers ?? [])
        .map(transfer => transfer.recipientRole).filter(Boolean);
    return expectedRoles.length === 0
        || expectedRoles.every(role => settlements.some(entry => entry.metadata?.role === role));
}

function diagnoseFinancialClose(finance, decisions) {
    const intents=finance.intents ?? [];
    const settled=intents.filter(i=>i.state === "SETTLED").length;
    const exactCodes=new Set(["SENDER_MISMATCH","DESTINATION_MISMATCH","AMOUNT_MISMATCH","MISSING_REFERENCE","REFERENCE_MISMATCH","LATE_PAYMENT","UNMATCHED","UNATTRIBUTED_TRANSFER","DUPLICATE"]);
    const code=decisions.some(d=>d.decision === "PROVIDER_UNAVAILABLE") ? "PROVIDER_UNAVAILABLE"
        : decisions.some(d=>d.decision === "UNVERIFIED" || d.decision === "PENDING_CONFIRMATION") ? "BLOCKCHAIN_CONFIRMATION_INCOMPLETE"
            : decisions.some(d=>exactCodes.has(d.decision)) ? "RECEIVED_TRANSFER_DID_NOT_MATCH_PAYMENT_INTENT"
                : settled < intents.length ? "PAYMENT_NOT_RECEIVED_BEFORE_ROOM_DEADLINE"
                    : finance.outcome?.kind === "PAYOUT" ? "PAYOUT_COMPLETED"
                        : finance.closedRoom?.closureReason ?? finance.outcome?.reason ?? "ROOM_CLOSED";
    return {code, settledPlayers:settled, requiredPlayers:intents.length,
        evidence:decisions.filter(d=>d.decision !== "SETTLED").map(d=>({
            at:d.at, playerId:d.playerId ?? null, transactionId:d.transactionId ?? null,
            paymentReference:d.paymentReference ?? null, decision:d.decision, reason:d.reason ?? null
        }))};
}

export function buildFinalFinancialReport(finance, decisions, recovery) {
    const intents=finance.intents ?? [], receipts=finance.receipts ?? [], refunds=finance.refunds ?? [];
    const settled=new Set(intents.filter(i=>i.state === "SETTLED").map(i=>i.transactionId));
    const sum=rows=>rows.reduce((n,r)=>n+(Number.isSafeInteger(r.amountAtomic)?r.amountAtomic:0),0);
    const uncredited=receipts.filter(r=>!settled.has(r.transactionId));
    const completedRefunds=refunds.filter(r=>r.state === "COMPLETE");
    const receivedAtomic=sum(receipts), settledStakeAtomic=sum(intents.filter(i=>i.state === "SETTLED"));
    const notCreditedAtomic=sum(uncredited), returnedAtomic=sum(completedRefunds.map(r=>({amountAtomic:r.transferAmountAtomic ?? r.amountAtomic})));
    const awaitingReturnAtomic=sum(refunds.filter(r=>r.state !== "COMPLETE").map(r=>({amountAtomic:r.transferAmountAtomic ?? r.amountAtomic})));
    return {schemaVersion:1, roomId:finance.roomId, network:finance.network,
        generatedAt:new Date().toISOString(), currency:"TON", atomicUnit:"nanoton",
        receivedAtomic, settledStakeAtomic,
        notCreditedAtomic, returnedAtomic,
        refundFeesAtomic:completedRefunds.reduce((n,r)=>n+(r.gasChargeAtomic ?? 0),0),
        awaitingReturnAtomic,
        amountsGram:{received:receivedAtomic/1_000_000_000,settled:settledStakeAtomic/1_000_000_000,
            notCredited:notCreditedAtomic/1_000_000_000,returned:returnedAtomic/1_000_000_000,
            awaitingReturn:awaitingReturnAtomic/1_000_000_000},
        gameId:finance.gameId ?? null,
        unresolvedReceiptCount:(finance.unresolvedReceipts ?? []).length,
        requiresInvestigation:recovery.requiresReconciliation || decisions.some(d=>["AMBIGUOUS","UNVERIFIED","PROVIDER_UNAVAILABLE","PENDING_CONFIRMATION","UNATTRIBUTED_TRANSFER","DUPLICATE","SENDER_MISMATCH","DESTINATION_MISMATCH","AMOUNT_MISMATCH","MISSING_REFERENCE","REFERENCE_MISMATCH","LATE_PAYMENT","UNMATCHED"].includes(d.decision)),
        closeReason:finance.closedRoom?.closureReason ?? finance.outcome?.reason ?? null,
        completionCause:diagnoseFinancialClose(finance, decisions),
        closeEvidence:{closedRoom:finance.closedRoom ?? null, observations:finance.paymentObservations ?? [],
            decisions:decisions.map(d=>({at:d.at,transactionId:d.transactionId,playerId:d.playerId,decision:d.decision,reason:d.reason}))},
        paymentCounts:{required:intents.length,settled:intents.filter(i=>i.state === "SETTLED").length,
            receipts:receipts.length,returnObligations:refunds.length}};
}

/**
 * Verify source files unchanged after archive (test helper).
 */
export function verifySourceFilesUnchanged(manifest) {

    for (const entry of manifest) {

        const hash = createHash("sha256");

        hash.update(readFileSync(entry.sourcePath));

        if (hash.digest("hex") !== entry.sha256) {

            throw new Error(`Source file mutated: ${entry.sourcePath}`);

        }

    }

}

export function writeStagingStatus(stagingPath, payload) { durableWriteJson(stagingPath, payload); }
