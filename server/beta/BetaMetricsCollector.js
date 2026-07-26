/**
 * R8.0D — Aggregate metrics facade over telemetry + registries.
 */

export class BetaMetricsCollector {

    /**
     * @param {{
     *   telemetryManager: import("./BetaTelemetryManager.js").BetaTelemetryManager,
     *   participantRegistry: import("./BetaParticipantRegistry.js").BetaParticipantRegistry,
     *   feedbackManager: import("./BetaFeedbackManager.js").BetaFeedbackManager,
     *   incidentManager: import("./BetaIncidentManager.js").BetaIncidentManager,
     *   crashCollector: import("./BetaCrashCollector.js").BetaCrashCollector
     * }} deps
     */
    constructor(deps) {

        this._telemetry = deps.telemetryManager;

        this._participants = deps.participantRegistry;

        this._feedback = deps.feedbackManager;

        this._incidents = deps.incidentManager;

        this._crashes = deps.crashCollector;

    }

    /**
     * Refresh telemetry and return a frozen aggregate bag.
     */
    collect() {

        const telemetry = this._telemetry.collect();

        const participants = this._participants.summary();

        const feedback = this._feedback.summary();

        const incidents = this._incidents.summary();

        const crashes = this._crashes.summary();

        const crashRate = this._crashes.crashRate(
            telemetry.session.gamesCompleted
        );

        return Object.freeze({
            collectedAt: telemetry.collectedAt,
            telemetry,
            participants,
            feedback,
            incidents,
            crashes,
            crashRate,
            activeSessions: telemetry.activeSessions
        });

    }

}
