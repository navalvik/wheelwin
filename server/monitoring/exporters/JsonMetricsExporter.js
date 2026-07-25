/**
 * R7.0E — JSON metrics exporter (read-only).
 */

export class JsonMetricsExporter {

    /**
     * @param {import("./MetricsSnapshot.js").MetricsSnapshot} snapshot
     */
    export(snapshot) {

        return snapshot.toSafeSummary();

    }

}
