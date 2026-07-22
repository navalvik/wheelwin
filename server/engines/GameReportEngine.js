import {
    buildGameReport,
    formatGameReportAsText
} from "./gameReport/buildGameReport.js";

/**
 * R6.4 — Authoritative Game Report store.
 *
 * Builds one permanent report per completed game from the frozen audit report.
 * Does not alter PaymentEngine, WinnerEngine, or gameplay — presentation record only.
 */
export class GameReportEngine {

    constructor({
        logger,
        gameCatalog,
        playerManager,
        serverVersion = "1.0.0"
    }) {

        this._logger = logger;

        this._gameCatalog = gameCatalog;

        this._playerManager = playerManager;

        this._serverVersion = serverVersion;

        this._reports = new Map();

        this._reportsByReportId = new Map();

        this._initialized = false;

    }

    initialize() {

        this._initialized = true;

    }

    shutdown() {

        this._reports.clear();

        this._reportsByReportId.clear();

        this._initialized = false;

    }

    /**
     * Creates and stores the authoritative Game Report for a finished game.
     * Idempotent: the first report for a gameId wins.
     */
    createFromAuditReport(auditReport, { auditId = null } = {}) {

        this._assertInitialized();

        const gameId = auditReport?.gameId;

        if (!gameId) {

            throw new Error("GameReportEngine requires auditReport.gameId");

        }

        const existing = this._reports.get(gameId);

        if (existing) {

            return existing;

        }

        const playerIdentities = {};

        for (const player of auditReport.configuration?.players ?? []) {

            const snapshot = this._playerManager?.getIdentity?.(player.playerId);

            if (snapshot) {

                playerIdentities[player.playerId] = snapshot;

            }

        }

        const report = buildGameReport({
            auditReport,
            auditId,
            playerIdentities,
            catalogColors: this._gameCatalog?.getColors?.() ?? [],
            serverVersion: this._serverVersion,
            createdAt: auditReport.createdAt ?? Date.now()
        });

        this._reports.set(gameId, report);

        if (report.reportId) {

            this._reportsByReportId.set(report.reportId, gameId);

        }

        this._logger?.info?.(
            `Game Report Created: ${report.reportId} | gameId=${gameId}`
        );

        return report;

    }

    /**
     * Resolve by gameId or reportId.
     */
    resolveReport(id) {

        if (!id) {

            return null;

        }

        const byGameId = this._reports.get(id);

        if (byGameId) {

            return byGameId;

        }

        const gameId = this._reportsByReportId.get(id);

        if (gameId) {

            return this._reports.get(gameId) ?? null;

        }

        for (const report of this._reports.values()) {

            if (report?.reportId === id) {

                return report;

            }

        }

        return null;

    }

    getReport(gameId) {

        return this.resolveReport(gameId);

    }

    getReportText(id) {

        const report = this.resolveReport(id);

        return report ? formatGameReportAsText(report) : null;

    }

    removeReport(gameId) {

        const report = this._reports.get(gameId);

        if (report?.reportId) {

            this._reportsByReportId.delete(report.reportId);

        }

        return this._reports.delete(gameId);

    }

    getActiveReportCount() {

        return this._reports.size;

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("GameReportEngine is not initialized");

        }

    }

}
