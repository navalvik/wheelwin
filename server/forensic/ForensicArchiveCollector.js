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
                gameMode: roomMode,
                displayMode: roomMode === "NO_FRIENDS"
                    ? "НЕТ ДРУЗЕЙ"
                    : roomMode === "FRIENDS" ? "ЕСТЬ ДРУЗЬЯ" : "UNKNOWN"
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

function buildPaymentDecisions(finance) {
    const decisions = [...(finance.paymentDecisions ?? [])];
    const intents = finance.intents ?? [];
    const receipts = finance.receipts ?? [];
    const settledTransactions = new Set(intents.filter(i => i.state === "SETTLED").map(i => i.transactionId));
    for (const receipt of receipts) {
        const owner = intents.find(intent => intent.paymentReference === receipt.paymentIntentId
            || (receipt.playerId && intent.playerId === receipt.playerId)
            || (() => { try { return tonAddressIdentitiesEqual(intent.expectedSender, receipt.senderAddress); } catch { return false; } })());
        let decision = "LATE_PAYMENT";
        let reason = "NO_MATCHING_PAYMENT_INTENT";
        if (settledTransactions.has(receipt.transactionId)) {
            decision = "SETTLED"; reason = null;
        } else if (owner) {
            const mismatch = [];
            if (!tonAddressIdentitiesEqual(receipt.senderAddress, owner.expectedSender)) mismatch.push("SENDER_MISMATCH");
            if (!tonAddressIdentitiesEqual(receipt.destinationWalletAddress, owner.destinationWalletAddress)) mismatch.push("DESTINATION_MISMATCH");
            if (receipt.amountAtomic !== owner.amountAtomic) mismatch.push("AMOUNT_MISMATCH");
            if (receipt.paymentReference !== owner.paymentReference) mismatch.push(receipt.paymentReference ? "REFERENCE_MISMATCH" : "MISSING_REFERENCE");
            if (receipt.transactionTime < owner.createdAt || receipt.transactionTime >= owner.expiresAt) mismatch.push("LATE_PAYMENT");
            decision = mismatch[0] ?? "PENDING_CONFIRMATION";
            reason = mismatch.length ? mismatch.join("+") : "SETTLEMENT_NOT_YET_CONFIRMED";
        }
        decisions.push({at:receipt.transactionTime, transactionId:receipt.transactionId,
            playerId:receipt.playerId ?? owner?.playerId ?? null,
            paymentReference:receipt.paymentReference ?? null, decision, reason,
            amountAtomic:receipt.amountAtomic, senderAddress:receipt.senderAddress,
            destinationWalletAddress:receipt.destinationWalletAddress});
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
    return decisions.sort((a,b)=>(a.at ?? 0)-(b.at ?? 0));
}

function buildFinancialRecovery(finance) {
    const ledger=finance.ledger ?? [];
    const payouts=ledger.filter(entry => ["PAYOUT_PLAN", "PAYOUT_SETTLEMENT", "NET_PAYOUT",
        "WINNER_GROSS_ALLOCATION", "OWNER_GROSS_ALLOCATION", "OWNER_COMMISSION_WAIVED"].includes(entry.kind));
    const openPayouts=ledger.filter(entry=>entry.kind==="NET_PAYOUT" && !ledger.some(other=>
        (other.kind==="PAYOUT_SETTLEMENT" || (entry.metadata?.role==="OWNER"
            && other.kind==="OWNER_COMMISSION_WAIVED"))
        && other.metadata?.payoutId===entry.metadata?.payoutId
        && other.metadata?.recipientId===entry.metadata?.recipientId));
    return {schemaVersion:1, roomId:finance.roomId, closedRoom:finance.closedRoom ?? null,
        receipts:finance.receipts ?? [], refunds:finance.refunds ?? [], payouts,
        outstandingObligations:finance.outstandingObligations ?? 0,
        requiresReconciliation:(finance.receipts ?? []).some(r => !r.playerId || !r.paymentIntentId)
            || (finance.refunds ?? []).some(r => r.state !== "COMPLETE")
            || openPayouts.length>0};
}

function diagnoseFinancialClose(finance, decisions) {
    const intents=finance.intents ?? [];
    const settled=intents.filter(i=>i.state === "SETTLED").length;
    const exactCodes=new Set(["SENDER_MISMATCH","AMOUNT_MISMATCH","MISSING_REFERENCE","REFERENCE_MISMATCH","LATE_PAYMENT","UNMATCHED"]);
    const code=decisions.some(d=>d.decision === "PROVIDER_UNAVAILABLE") ? "PROVIDER_UNAVAILABLE"
        : decisions.some(d=>d.decision === "UNVERIFIED" || d.decision === "PENDING_CONFIRMATION") ? "BLOCKCHAIN_CONFIRMATION_INCOMPLETE"
            : decisions.some(d=>exactCodes.has(d.decision)) ? "RECEIVED_TRANSFER_DID_NOT_MATCH_PAYMENT_INTENT"
                : settled < intents.length ? "PAYMENT_NOT_RECEIVED_BEFORE_ROOM_DEADLINE"
                    : finance.closedRoom?.closureReason ?? finance.outcome?.reason ?? "ROOM_CLOSED";
    return {code, settledPlayers:settled, requiredPlayers:intents.length,
        evidence:decisions.filter(d=>d.decision !== "SETTLED").map(d=>({
            at:d.at, playerId:d.playerId ?? null, transactionId:d.transactionId ?? null,
            paymentReference:d.paymentReference ?? null, decision:d.decision, reason:d.reason ?? null
        }))};
}

function buildFinalFinancialReport(finance, decisions, recovery) {
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
        ownerCommissionWaivedAtomic:(finance.ledger ?? []).filter(r=>
            r.kind==="OWNER_COMMISSION_WAIVED").reduce((n,r)=>n+(r.amountAtomic ?? 0),0),
        amountsGram:{received:receivedAtomic/1_000_000_000,settled:settledStakeAtomic/1_000_000_000,
            notCredited:notCreditedAtomic/1_000_000_000,returned:returnedAtomic/1_000_000_000,
            awaitingReturn:awaitingReturnAtomic/1_000_000_000},
        requiresInvestigation:recovery.requiresReconciliation || decisions.some(d=>["AMBIGUOUS","UNVERIFIED","PROVIDER_UNAVAILABLE","PENDING_CONFIRMATION","SENDER_MISMATCH","AMOUNT_MISMATCH","MISSING_REFERENCE","REFERENCE_MISMATCH","LATE_PAYMENT","UNMATCHED"].includes(d.decision)),
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
