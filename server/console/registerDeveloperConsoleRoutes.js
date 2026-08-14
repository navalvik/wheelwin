import { createAdministratorAuthMiddleware } from "./auth/developerAuthMiddleware.js";

/**
 * R6.0C / R6.1 — Read-only Developer Console HTTP routes.
 * Independent of /debug/*. Projection routes require developer auth when enabled.
 */
export function registerDeveloperConsoleRoutes(
    app,
    projectionService,
    {
        authMiddleware = null,
        authService = null,
        gameDiagnosticLogManager = null,
        sessionHistoryArchive = null
    } = {}
) {

    if (!app || !projectionService) {

        return;

    }

    if (typeof authMiddleware === "function") {

        app.use("/console", authMiddleware);

    }

    app.get("/console/server", (req, res) => {

        res.json(projectionService.buildServerOverview());

    });

    app.get("/console/rooms", (req, res) => {

        res.json(projectionService.buildRoomsIndex());

    });

    app.get("/console/rooms/:roomId", (req, res) => {

        const detail = projectionService.buildRoomDetail(req.params.roomId);

        if (!detail) {

            res.status(404).json({ error: "Room not found" });

            return;

        }

        res.json(detail);

    });

    /**
     * R6.2B — DEV-only download of the current room diagnostic log.
     */
    app.get("/console/rooms/:roomId/diagnostic-log", (req, res) => {

        if (!gameDiagnosticLogManager?.isEnabled?.()) {

            res.status(404).json({ error: "Diagnostic logging is not enabled" });

            return;

        }

        const roomId = req.params.roomId;

        const buffer = gameDiagnosticLogManager.readLog(roomId);

        if (!buffer) {

            res.status(404).json({
                error: "Diagnostic log not found for this room"
            });

            return;

        }

        const filePath = gameDiagnosticLogManager.getLogPath(roomId);

        const filename = filePath
            ? filePath.split(/[/\\]/).pop()
            : `ROOM_${roomId}.log`;

        res.setHeader("Content-Type", "application/octet-stream");

        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${filename}"`
        );

        res.setHeader("Content-Length", buffer.length);

        res.setHeader("Cache-Control", "no-store");

        res.end(buffer);

    });

    app.get("/console/games/:gameId", (req, res) => {

        const detail = projectionService.buildGameDetail(req.params.gameId);

        if (!detail) {

            res.status(404).json({ error: "Game not found" });

            return;

        }

        res.json(detail);

    });

    app.get("/console/players", (req, res) => {

        res.json(projectionService.buildPlayersIndex());

    });

    app.get("/console/payments", (req, res) => {

        res.json(projectionService.buildPaymentsOverview());

    });

    app.get("/console/recovery", (req, res) => {

        res.json(projectionService.buildRecoveryOverview());

    });

    app.get("/console/simulation", (req, res) => {

        res.json(projectionService.buildSimulationOverview());

    });

    app.get("/console/metrics", (req, res) => {

        res.json(projectionService.buildMetricsOverview());

    });

    app.get("/console/system", (req, res) => {

        res.json(projectionService.buildSystemInformation());

    });

    app.get("/console/blockchain", (req, res) => {

        res.json(projectionService.buildBlockchainStatus());

    });

    const requireAdministrator = authService
        ? createAdministratorAuthMiddleware(authService)
        : null;

    /**
     * R17.8M.1 — Live deployer wallet observability (Administrator-only).
     */
    app.get(
        "/console/ton/deployer-wallet",
        requireAdministrator ?? ((req, res, next) => next()),
        async (req, res) => {

            try {

                const status = await projectionService.buildDeployerWalletStatus();

                res.json(status);

            } catch (error) {

                res.status(500).json({
                    error: "Failed to load deployer wallet status",
                    message: error?.message ?? "Unknown error"
                });

            }

        }
    );

    /**
     * R7.0 — Immutable session lifecycle history (read-only archive).
     */
    app.get("/console/history", (req, res) => {

        if (!sessionHistoryArchive?.listRecords) {

            res.status(503).json({ error: "Session history archive unavailable" });

            return;

        }

        const query = req.query ?? {};

        res.json(sessionHistoryArchive.listRecords({
            roomId: query.roomId || null,
            gameId: query.gameId || null,
            lifecycleResult: query.lifecycleResult || null,
            playerNickname: query.playerNickname || null,
            walletAddress: query.walletAddress || null,
            fromAt: query.fromAt ? Number(query.fromAt) : null,
            toAt: query.toAt ? Number(query.toAt) : null,
            sort: query.sort || "newest",
            limit: query.limit ? Number(query.limit) : 200,
            offset: query.offset ? Number(query.offset) : 0
        }));

    });

    app.get("/console/history/:sessionId", (req, res) => {

        if (!sessionHistoryArchive?.getRecord) {

            res.status(503).json({ error: "Session history archive unavailable" });

            return;

        }

        const record = sessionHistoryArchive.getRecord(req.params.sessionId);

        if (!record) {

            res.status(404).json({ error: "History record not found" });

            return;

        }

        res.json(record);

    });

    app.get("/console/history/:sessionId/download", (req, res) => {

        if (!sessionHistoryArchive?.getDownloadBuffer) {

            res.status(503).json({ error: "Session history archive unavailable" });

            return;

        }

        const download = sessionHistoryArchive.getDownloadBuffer(
            req.params.sessionId
        );

        if (!download) {

            res.status(404).json({ error: "History record not found" });

            return;

        }

        res.setHeader("Content-Type", "application/json; charset=utf-8");

        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${download.filename}"`
        );

        res.setHeader("Content-Length", download.buffer.length);

        res.setHeader("Cache-Control", "no-store");

        res.end(download.buffer);

    });

}
