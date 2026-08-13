/**
 * R14.3 — Developer Console advertisement management HTTP routes.
 * Isolated from gameplay namespaces. Uses existing developer auth roles.
 */

import {
    createAdministratorAuthMiddleware,
    createDeveloperAuthMiddleware
} from "./auth/developerAuthMiddleware.js";
import { AdvertisementValidationError } from "../advertisement/AdvertisementValidator.js";

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

/**
 * @param {import("express").Express} app
 * @param {{
 *   authService: object,
 *   advertisementManager: import("../advertisement/AdvertisementManager.js").AdvertisementManager
 * }} deps
 */
export function registerAdvertisementRoutes(app, { authService, advertisementManager }) {

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
                role: resolveRole(req, authService),
                username: resolveUsername(req),
                createdBy: resolveUsername(req)
            });

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

}
