/**
 * R6.2 — Environment control HTTP routes (administrator-only mutations).
 */

import {
    createAdministratorAuthMiddleware,
    createDeveloperAuthMiddleware
} from "../auth/developerAuthMiddleware.js";

export function registerEnvironmentControlRoutes(
    app,
    { authService, environmentService }
) {

    if (!app || !authService || !environmentService) {

        return;

    }

    const requireAuth = createDeveloperAuthMiddleware(authService);

    const requireAdministrator = createAdministratorAuthMiddleware(authService);

    app.get("/console/environment", requireAuth, (req, res) => {

        res.json(environmentService.getStatus());

    });

    app.get("/console/environment/summary", requireAuth, (req, res) => {

        res.json(environmentService.buildSummary({
            authEnabled: authService.isEnabled(),
            authenticated: true,
            role: req.developer?.role ?? null
        }));

    });

    app.post("/console/environment/switch", requireAdministrator, (req, res) => {

        const result = environmentService.switchEnvironment({
            targetEnvironment: req.body?.targetEnvironment,
            password: req.body?.password,
            confirmationPhrase: req.body?.confirmationPhrase,
            finalConfirmationPhrase: req.body?.finalConfirmationPhrase,
            username: req.developer?.username ?? "unknown",
            role: req.developer?.role ?? null,
            sessionId: req.developer?.sessionId ?? null,
            clientIp: req.ip
        });

        if (!result.ok) {

            res.status(result.status).json({ error: result.error });

            return;

        }

        res.json(result);

    });

}
