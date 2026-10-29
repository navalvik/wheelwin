import { Address } from "@ton/core";
import { createAdministratorAuthMiddleware } from "./auth/developerAuthMiddleware.js";
import { canPerformAdministratorActions } from "./auth/developerRoles.js";
import { readMultipartOggUpload } from "./configuration/readMultipartOggUpload.js";
import { AUDIO_UPLOAD_MAX_BYTES } from "./configuration/uploadAudioRegistryAsset.js";

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
        sessionHistoryArchive = null,
        runtimeConfigurationService = null,
        audioRegistryService = null,
        walletQuarantineService = null
    } = {}
) {

    if (!app || !projectionService) {

        return;

    }

    if (typeof authMiddleware === "function") {

        app.use("/console", authMiddleware);

    }

    app.get("/console/wallets/balances", async (req, res) => {

        const network = String(req.query?.network ?? "").trim().toLowerCase();
        if (network !== "testnet" && network !== "mainnet") {
            res.status(400).json({ error: "network must be testnet or mainnet" });
            return;
        }

        if (req.developer && !canPerformAdministratorActions(req.developer.role)) {
            res.status(403).json({ error: "Administrator access required" });
            return;
        }

        const configuredNetwork = String(process.env.TON_NETWORK ?? "")
            .trim().toLowerCase();
        const networkWalletKey = `OWNER_WALLET_${network.toUpperCase()}`;
        const configuredWallet = String(process.env[networkWalletKey] ?? "").trim();
        const activeNetworkWallet = network === configuredNetwork
            ? String(process.env.OWNER_WALLET ?? "").trim()
            : "";
        const ownerWallet = configuredWallet || activeNetworkWallet;

        if (!ownerWallet) {
            res.setHeader("Cache-Control", "no-store");
            res.json({
                network,
                configured: false,
                ownerWallet: null,
                balanceNano: null,
                accountState: null,
                updatedAt: new Date().toISOString()
            });
            return;
        }

        let rawAddress;
        try {
            rawAddress = Address.parse(ownerWallet).toRawString();
        } catch {
            res.status(503).json({ error: `Owner Wallet address is invalid for ${network}` });
            return;
        }

        const apiKey = network === "mainnet"
            ? (process.env.TONCENTER_MAINNET_API_KEY ?? process.env.TON_API_KEY ?? "")
            : (process.env.TONCENTER_TESTNET_API_KEY ?? process.env.TON_API_KEY ?? "");
        const endpoint = network === "mainnet"
            ? "https://toncenter.com/api/v2/getAddressInformation"
            : "https://testnet.toncenter.com/api/v2/getAddressInformation";
        const url = new URL(endpoint);
        url.searchParams.set("address", rawAddress);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8_000);

        try {
            const headers = { Accept: "application/json" };
            if (apiKey) headers["X-API-Key"] = apiKey;
            const response = await fetch(url, { headers, signal: controller.signal });
            const body = await response.json().catch(() => null);
            if (!response.ok || body?.ok === false || !body?.result) {
                const detail = String(body?.error ?? `HTTP ${response.status}`).slice(0, 160);
                res.status(502).json({ error: `TonCenter ${network} balance lookup failed`, detail });
                return;
            }

            const balanceNano = BigInt(String(body.result.balance ?? "0"));
            res.setHeader("Cache-Control", "no-store");
            res.json({
                network,
                configured: true,
                ownerWallet,
                balanceNano: balanceNano.toString(),
                accountState: String(body.result.state ?? "unknown"),
                updatedAt: new Date().toISOString()
            });
        } catch (error) {
            res.status(502).json({
                error: `TonCenter ${network} balance lookup failed`,
                detail: error?.name === "AbortError" ? "request timed out" : "provider unavailable"
            });
        } finally {
            clearTimeout(timeout);
        }

    });

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

    const requireAdministrator = authService
        ? createAdministratorAuthMiddleware(authService)
        : null;

    const adminGate = requireAdministrator ?? ((req, res, next) => next());

    // The quarantine endpoints are NEVER accessible under open developer
    // access. They require an explicitly configured Administrator identity.
    const strictAdminGate = (req,res,next) => {
        if (!authService?.isEnabled?.() || authService?.allowsOpenAccess?.())
            return res.status(403).json({error:"ADMINISTRATOR_LOGIN_REQUIRED"});
        return createAdministratorAuthMiddleware(authService)(req,res,next);
    };
    const quarantineError = (res,error) => {
        const code = String(error?.message ?? "WALLET_ADMIN_OPERATION_FAILED");
        const status = /UNAVAILABLE|DISABLED|NOT_CONFIGURED/.test(code) ? 503
            : /OBLIGATIONS|NOT_EMPTY|IN_PROGRESS|RECONCILIATION|NOT_IDLE|PREVIOUS_ATTEMPT/.test(code) ? 409
                : 400;
        return res.status(status).json({error:code});
    };
    if (walletQuarantineService) {
        app.get("/console/wallets/quarantine", strictAdminGate, async (req,res) => {
            try {
                res.setHeader("Cache-Control","no-store");
                res.json(await walletQuarantineService.status(req.query?.roomNumber ?? null));
            } catch(error) {quarantineError(res,error);}
        });
        for (const action of ["release","sweep"]) {
            app.post(`/console/wallets/quarantine/${action}`,strictAdminGate,async (req,res) => {
                try {
                    res.setHeader("Cache-Control","no-store");
                    res.json(await walletQuarantineService[action]({
                        roomNumber:req.body?.roomNumber,
                        confirmation:req.body?.confirmation
                    }));
                } catch(error) {quarantineError(res,error);}
            });
        }
    }

    /**
     * R17.9I.3 — Administrator-only Runtime Configuration (view + mutate).
     */
    app.get("/console/configuration/runtime", adminGate, (req, res) => {

        try {

            res.json(projectionService.buildRuntimeConfiguration({
                canEdit: true
            }));

        } catch (error) {

            res.status(500).json({
                error: "Failed to load runtime configuration",
                message: error?.message ?? "Unknown error"
            });

        }

    });

    /**
     * R17.9I.3 — Administrator-only Audio Registry (view).
     */
    app.get("/console/configuration/audio-registry", adminGate, (req, res) => {

        try {

            res.json(projectionService.buildAudioRegistry({ canEdit: true }));

        } catch (error) {

            res.status(500).json({
                error: "Failed to load audio registry",
                message: error?.message ?? "Unknown error"
            });

        }

    });

    /**
     * R17.9G.1 — Administrator-only runtime configuration mutation.
     * Applies to future GAME_INITIALIZED sessions only.
     */
    app.put(
        "/console/configuration/runtime",
        adminGate,
        (req, res) => {

            if (!runtimeConfigurationService?.update) {

                res.status(503).json({
                    error: "Runtime configuration service unavailable"
                });

                return;

            }

            try {

                const result = runtimeConfigurationService.update(req.body, {
                    username: req.developer?.username ?? null,
                    role: req.developer?.role ?? "Administrator"
                });

                if (!result.ok) {

                    res.status(result.status ?? 400).json({
                        error: result.error ?? "Update failed",
                        details: result.details ?? undefined
                    });

                    return;

                }

                res.json({
                    ok: true,
                    message: result.message,
                    changes: result.changes,
                    auditRecords: result.auditRecords,
                    configuration: projectionService.buildRuntimeConfiguration({
                        canEdit: true
                    })
                });

            } catch (error) {

                res.status(500).json({
                    error: "Failed to update runtime configuration",
                    message: error?.message ?? "Unknown error"
                });

            }

        }
    );

    /**
     * R17.9I.3 — Administrator-only Audio Registry mutation.
     * Applies to future audio sessions only (playback still disabled).
     */
    app.put(
        "/console/configuration/audio-registry",
        adminGate,
        (req, res) => {

            if (!audioRegistryService?.update) {

                res.status(503).json({
                    error: "Audio Registry service unavailable"
                });

                return;

            }

            try {

                const result = audioRegistryService.update(req.body, {
                    username: req.developer?.username ?? null,
                    role: req.developer?.role ?? "Administrator"
                });

                if (!result.ok) {

                    res.status(result.status ?? 400).json({
                        error: result.error ?? "Update failed",
                        details: result.details ?? undefined
                    });

                    return;

                }

                res.json({
                    ok: true,
                    message: result.message,
                    changes: result.changes,
                    auditRecords: result.auditRecords,
                    registry: projectionService.buildAudioRegistry({
                        canEdit: true
                    })
                });

            } catch (error) {

                res.status(500).json({
                    error: "Failed to update audio registry",
                    message: error?.message ?? "Unknown error"
                });

            }

        }
    );

    /**
     * R17.9J.2B — Administrator-only .ogg upload into client/src/assets/audio.
     * Does not use server/uploads. Does not change enabled/loop.
     */
    app.post(
        "/console/configuration/audio-registry/:id/upload",
        adminGate,
        async (req, res) => {

            if (!audioRegistryService?.uploadAsset) {

                res.status(503).json({
                    error: "Audio Registry service unavailable"
                });

                return;

            }

            try {

                const parsed = await readMultipartOggUpload(req, {
                    fieldName: "file",
                    maxBytes: AUDIO_UPLOAD_MAX_BYTES
                });

                if (!parsed.ok) {

                    res.status(parsed.status ?? 400).json({
                        error: parsed.error ?? "Upload failed"
                    });

                    return;

                }

                const result = audioRegistryService.uploadAsset(
                    req.params.id,
                    parsed.buffer,
                    {
                        originalFilename: parsed.filename,
                        username: req.developer?.username ?? null,
                        role: req.developer?.role ?? "Administrator"
                    }
                );

                if (!result.ok) {

                    res.status(result.status ?? 400).json({
                        error: result.error ?? "Upload failed"
                    });

                    return;

                }

                res.json({
                    ok: true,
                    message: result.message,
                    file: result.file,
                    assetStatus: result.assetStatus,
                    exists: result.exists,
                    auditRecord: result.auditRecord,
                    registry: result.registry
                        ?? projectionService.buildAudioRegistry({
                            canEdit: true
                        })
                });

            } catch (error) {

                res.status(500).json({
                    error: "Failed to upload audio asset",
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
