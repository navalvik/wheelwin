/**
 * R7.0D — Human-readable console formatter (development).
 */

export class ConsoleFormatter {

    format(record) {

        const ts = record.timestamp ?? new Date().toISOString();

        const level = String(record.level ?? "info").toUpperCase();

        const service = record.service ?? "wheelwin";

        const trace = record.traceId ? ` trace=${record.traceId.slice(0, 8)}` : "";

        const ids = [
            record.roomId ? `room=${record.roomId}` : null,
            record.gameId ? `game=${record.gameId}` : null,
            record.playerId ? `player=${record.playerId}` : null
        ].filter(Boolean).join(" ");

        const suffix = ids ? ` ${ids}` : "";

        const channel = record.channel === "audit" ? " [AUDIT]" : "";

        let line = `${ts} ${level}${channel} [${service}]${trace}${suffix} ${record.message}`;

        if (record.error?.stack) {

            line += `\n${record.error.stack}`;

        }

        return `${line}\n`;

    }

}
