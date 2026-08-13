/**
 * R14.3 — Developer Console advertisement management HTTP routes.
 * Isolated from gameplay namespaces. Uses existing developer auth roles.
 */

import {
    createAdministratorAuthMiddleware,
    createDeveloperAuthMiddleware
} from "./auth/developerAuthMiddleware.js";
import {
    AdvertisementValidationError
} from "../advertisement/AdvertisementValidator.js";
import { ALLOWED_MIME_HINTS } from "../advertisement/advertisementTypes.js";

function resolveRole(req, authService) {

    if (authService?.allowsOpenAccess?.() === true) {

        return req.developer?.role ?? "Administrator";

    }

    return req.developer?.role ?? "Viewer";

}

function resolveUsername(req) {

    return req.developer?.username ?? "Administrator";

}

function mapValidationError(error) {

    if (!(error instanceof AdvertisementValidationError)) {

        return {
            status: 500,
            body: { error: "Internal Server Error", message: error.message }
        };

    }

    switch (error.code) {

        case "FORBIDDEN":
            return {
                status: 403,
                body: { error: "Forbidden", code: error.code, message: error.message }
            };

        case "NOT_FOUND":
            return {
                status: 404,
                body: { error: "Not Found", code: error.code, message: error.message }
            };

        default:
            return {
                status: 400,
                body: { error: "Bad Request", code: error.code, message: error.message }
            };

    }

}

function decodeUploadBytes(body) {

    if (Buffer.isBuffer(body?.bytes)) {

        return body.bytes;

    }

    if (typeof body?.contentBase64 === "string" && body.contentBase64.trim()) {

        return Buffer.from(body.contentBase64, "base64");

    }

    if (typeof body?.content === "string" && body.content.length > 0) {

        return Buffer.from(body.content, "binary");

    }

    return null;

}

function toListItem(campaign) {

    return {
        id: campaign.id,
        filename: campaign.filename,
        priority: campaign.priority,
        advertiserName: campaign.advertiserName,
        status: campaign.status,
        createdAt: campaign.createdAt,
        expiresAt: campaign.expiresAt ?? null
    };

}

function refreshAdvertisementScheduler(scheduler, reason) {

    try {

        scheduler?.refresh?.(reason);

    } catch {

        // Console mutations must succeed even if scheduler refresh fails.

    }

}

/**
 * @param {import("express").Express} app
 * @param {{
 *   authService: object,
 *   advertisementManager: import("../advertisement/AdvertisementManager.js").AdvertisementManager,
 *   advertisementRedirectService?: import("../advertisement/AdvertisementRedirectService.js").AdvertisementRedirectService|null,
 *   advertisementScheduler?: import("../advertisement/AdvertisementScheduler.js").AdvertisementScheduler|null
 * }} deps
 */
export function registerAdvertisementRoutes(app, {
    authService,
    advertisementManager,
    advertisementRedirectService = null,
    advertisementScheduler = null
}) {

    if (!app || !advertisementManager) {

        return;

    }

    const requireAuth = authService
        ? createDeveloperAuthMiddleware(authService)
        : ((req, res, next) => next());

    const requireAdministrator = authService
        ? (req, res, next) => {

            // Open-access console mode treats mutations as Administrator.
            if (authService.allowsOpenAccess?.() === true) {

                req.developer = req.developer ?? {
                    role: "Administrator",
                    username: "Administrator"
                };

                return next();

            }

            return createAdministratorAuthMiddleware(authService)(req, res, next);

        }
        : ((req, res, next) => next());

    app.get("/console/advertisements", requireAuth, (req, res) => {

        try {

            const role = resolveRole(req, authService);
            const campaigns = advertisementManager.getCampaigns({ role });

            res.json({
                campaigns: campaigns.map(toListItem),
                storage: advertisementManager.getStorageUsage({ role })
            });

        } catch (error) {

            const mapped = mapValidationError(error);

            res.status(mapped.status).json(mapped.body);

        }

    });

    app.post("/console/advertisements/upload", requireAdministrator, (req, res) => {

        try {

            const body = req.body ?? {};
            const bytes = decodeUploadBytes(body);

            if (!bytes) {

                res.status(400).json({
                    error: "Bad Request",
                    code: "MISSING_BYTES",
                    message: "Provide contentBase64 (or bytes) with filename"
                });

                return;

            }

            const uploaded = advertisementManager.uploadAsset({
                filename: body.filename,
                bytes,
                role: resolveRole(req, authService),
                username: resolveUsername(req)
            });

            res.status(201).json(uploaded);

        } catch (error) {

            const mapped = mapValidationError(error);

            res.status(mapped.status).json(mapped.body);

        }

    });

    app.get("/console/advertisements/:id", requireAuth, (req, res) => {

        try {

            const role = resolveRole(req, authService);
            const campaign = advertisementManager.getCampaignById(
                req.params.id,
                { role }
            );

            if (!campaign) {

                res.status(404).json({ error: "Campaign not found" });

                return;

            }

            res.json(campaign);

        } catch (error) {

            const mapped = mapValidationError(error);

            res.status(mapped.status).json(mapped.body);

        }

    });

    app.post("/console/advertisements", requireAdministrator, (req, res) => {

        try {

            const body = req.body ?? {};
            const bytes = decodeUploadBytes(body);

            const campaign = advertisementManager.createCampaign({
                filename: body.filename,
                bytes,
                advertiserName: body.advertiserName,
                destinationUrl: body.destinationUrl,
                priority: body.priority,
                expiresAt: body.expiresAt,
                advertiserBid: body.advertiserBid ?? body.bid,
                bidCurrency: body.bidCurrency,
                role: resolveRole(req, authService),
                username: resolveUsername(req),
                createdBy: resolveUsername(req)
            });

            refreshAdvertisementScheduler(
                advertisementScheduler,
                "console-create"
            );

            res.status(201).json(campaign);

        } catch (error) {

            const mapped = mapValidationError(error);

            res.status(mapped.status).json(mapped.body);

        }

    });

    app.patch("/console/advertisements/:id", requireAdministrator, (req, res) => {

        try {

            const body = req.body ?? {};
            const patch = {};

            for (const key of [
                "priority",
                "destinationUrl",
                "advertiserName",
                "expiresAt",
                "status",
                "bid",
                "advertiserBid",
                "bidCurrency",
                "renewalStatus"
            ]) {

                if (Object.prototype.hasOwnProperty.call(body, key)) {

                    patch[key] = body[key];

                }

            }

            const updated = advertisementManager.updateCampaign(
                req.params.id,
                patch,
                {
                    role: resolveRole(req, authService),
                    username: resolveUsername(req)
                }
            );

            refreshAdvertisementScheduler(
                advertisementScheduler,
                "console-update"
            );

            res.json(updated);

        } catch (error) {

            const mapped = mapValidationError(error);

            res.status(mapped.status).json(mapped.body);

        }

    });

    app.post("/console/advertisements/:id/disable", requireAdministrator, (req, res) => {

        try {

            const disabled = advertisementManager.disableCampaign(req.params.id, {
                role: resolveRole(req, authService),
                username: resolveUsername(req)
            });

            refreshAdvertisementScheduler(
                advertisementScheduler,
                "console-disable"
            );

            res.json(disabled);

        } catch (error) {

            const mapped = mapValidationError(error);

            res.status(mapped.status).json(mapped.body);

        }

    });

    app.post("/console/advertisements/:id/renew", requireAdministrator, (req, res) => {

        try {

            const renewed = advertisementManager.renewCampaign(req.params.id, {
                role: resolveRole(req, authService),
                username: resolveUsername(req),
                expiresAt: req.body?.expiresAt ?? null
            });

            refreshAdvertisementScheduler(
                advertisementScheduler,
                "console-renew"
            );

            res.json(renewed);

        } catch (error) {

            const mapped = mapValidationError(error);

            res.status(mapped.status).json(mapped.body);

        }

    });

    app.delete("/console/advertisements/:id", requireAdministrator, (req, res) => {

        try {

            const result = advertisementManager.deleteCampaign(req.params.id, {
                role: resolveRole(req, authService),
                username: resolveUsername(req)
            });

            res.json(result);

        } catch (error) {

            const mapped = mapValidationError(error);

            res.status(mapped.status).json(mapped.body);

        }

    });

    // R14.5 — Public asset fetch for client AdvertisementSlot (isolated; no auth).
    app.get("/advertisements/assets/:filename", (req, res) => {

        try {

            const asset = advertisementManager.readPublicAsset(req.params.filename);

            if (!asset) {

                res.status(404).json({ error: "Asset not found" });

                return;

            }

            const mime = ALLOWED_MIME_HINTS[asset.extension] || "application/octet-stream";

            res.setHeader("Content-Type", mime);
            res.setHeader("Cache-Control", "public, max-age=300");
            res.status(200).end(asset.bytes);

        } catch (error) {

            if (error instanceof AdvertisementValidationError) {

                res.status(400).json({
                    error: "Bad Request",
                    code: error.code,
                    message: error.message
                });

                return;

            }

            res.status(500).json({ error: "Internal Server Error" });

        }

    });

    // R14.6 — Click redirect (record CLICK, then 302). No gameplay coupling.
    if (advertisementRedirectService) {

        app.get("/advertisements/click/:advertisementId", (req, res) => {

            try {

                const result = advertisementRedirectService.handleClick(
                    req.params.advertisementId
                );

                if (result.status === 302 && result.location) {

                    res.redirect(302, result.location);

                    return;

                }

                res.status(result.status).json({
                    error: result.error || "Click redirect failed",
                    code: result.code || null
                });

            } catch (error) {

                res.status(500).json({ error: "Internal Server Error" });

            }

        });

    }

}
