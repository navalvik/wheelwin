/**
 * R6.2 — Express middleware helpers for Developer Console authorization.
 */

function extractBearerToken(req) {

    const header = req.headers?.authorization;

    if (typeof header === "string" && header.startsWith("Bearer ")) {

        return header.slice("Bearer ".length).trim();

    }

    return null;

}

/**
 * Protects /console/* except auth endpoints.
 */
export function createDeveloperAuthMiddleware(authService) {

    return function developerAuthMiddleware(req, res, next) {

        if (!authService?.isEnabled?.()) {

            return next();

        }

        const path = req.path || "";

        const relative = path.startsWith("/console")
            ? path.slice("/console".length)
            : path;

        if (relative.startsWith("/auth/")) {

            return next();

        }

        const token = extractBearerToken(req);

        const claims = authService.verifyAccessToken(token);

        if (!claims) {

            authService.auditUnauthorized?.({
                path: req.originalUrl || req.url,
                ip: req.ip
            });

            return res.status(401).json({
                error: "Unauthorized",
                message: "Valid Developer access token required"
            });

        }

        req.developer = claims;

        return next();

    };

}

/**
 * Requires an authenticated Administrator session.
 */
export function createAdministratorAuthMiddleware(authService) {

    const requireAuth = createDeveloperAuthMiddleware(authService);

    return function administratorAuthMiddleware(req, res, next) {

        requireAuth(req, res, () => {

            if (!authService?.isAdministrator?.(req.developer)) {

                authService.auditPermissionDenied?.({
                    path: req.originalUrl || req.url,
                    username: req.developer?.username ?? null,
                    role: req.developer?.role ?? null,
                    sessionId: req.developer?.sessionId ?? null,
                    ip: req.ip,
                    action: "administrator_required"
                });

                return res.status(403).json({
                    error: "Forbidden",
                    message: "Administrator role required"
                });

            }

            return next();

        });

    };

}

export function createDeveloperSocketAuthMiddleware(authService) {

    return function developerSocketAuthMiddleware(socket, next) {

        if (!authService?.isEnabled?.()) {

            return next();

        }

        const token = socket.handshake?.auth?.token
            || socket.handshake?.query?.token
            || null;

        const claims = authService.verifyAccessToken(token);

        if (!claims) {

            authService.auditSocketRejected?.({
                socketId: socket.id,
                ip: socket.handshake?.address
            });

            return next(new Error("Unauthorized"));

        }

        socket.data.developer = claims;

        return next();

    };

}
