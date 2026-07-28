/**
 * R6.1 — Developer authentication HTTP routes.
 */

export function registerDeveloperAuthRoutes(app, authService) {

    if (!app || !authService) {

        return;

    }

    app.post("/console/auth/login", (req, res) => {

        const result = authService.login({
            username: req.body?.username,
            password: req.body?.password,
            clientIp: req.ip
        });

        if (!result.ok) {

            res.status(result.status).json({ error: result.error });

            return;

        }

        res.json(result.session);

    });

    app.post("/console/auth/refresh", (req, res) => {

        const result = authService.refresh({
            refreshToken: req.body?.refreshToken,
            clientIp: req.ip
        });

        if (!result.ok) {

            res.status(result.status).json({ error: result.error });

            return;

        }

        res.json(result.session);

    });

    app.post("/console/auth/logout", (req, res) => {

        const header = req.headers?.authorization;

        const accessToken = typeof header === "string"
            && header.startsWith("Bearer ")
            ? header.slice(7).trim()
            : null;

        authService.logout({
            refreshToken: req.body?.refreshToken,
            accessToken,
            clientIp: req.ip
        });

        res.json({ ok: true });

    });

    app.get("/console/auth/session", (req, res) => {

        if (!authService.isEnabled()) {

            res.json({
                authenticated: false,
                enabled: false,
                environment: authService.getEnvironment()
            });

            return;

        }

        const header = req.headers?.authorization;

        const accessToken = typeof header === "string"
            && header.startsWith("Bearer ")
            ? header.slice(7).trim()
            : null;

        const session = authService.getPublicSessionFromAccessToken(accessToken);

        if (!session) {

            res.status(401).json({
                authenticated: false,
                enabled: true,
                error: "Unauthorized"
            });

            return;

        }

        res.json({
            authenticated: true,
            enabled: true,
            ...session
        });

    });

    app.get("/console/auth/status", (req, res) => {

        res.json({
            enabled: authService.isEnabled(),
            environment: authService.getEnvironment(),
            appEnvironment: authService.getEnvironment()
        });

    });

}
