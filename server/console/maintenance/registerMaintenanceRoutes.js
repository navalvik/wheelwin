/**
 * R6.2 — Maintenance mode API placeholders (read-only / not implemented).
 */

import { createAdministratorAuthMiddleware } from "../auth/developerAuthMiddleware.js";
import { createDeveloperAuthMiddleware } from "../auth/developerAuthMiddleware.js";

export function registerMaintenanceRoutes(app, { authService, maintenanceService }) {

    if (!app || !maintenanceService) {

        return;

    }

    const requireAuth = authService
        ? createDeveloperAuthMiddleware(authService)
        : null;

    const requireAdministrator = authService
        ? createAdministratorAuthMiddleware(authService)
        : null;

    app.get("/console/maintenance", requireAuth ?? ((req, res, next) => next()), (req, res) => {

        res.json(maintenanceService.getStatus());

    });

    app.post("/console/maintenance/schedule", requireAdministrator ?? ((req, res, next) => next()), (req, res) => {

        const result = maintenanceService.scheduleMaintenance(req.body);

        res.status(result.status).json(result);

    });

}
