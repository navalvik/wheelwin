/**
 * R6.0C — Read-only Developer Console HTTP routes.
 * Independent of /debug/*. No authentication in this stage (R6.1).
 */
export function registerDeveloperConsoleRoutes(app, projectionService) {

    if (!app || !projectionService) {

        return;

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

}
