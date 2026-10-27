import { join } from "node:path";

/**
 * Restored October R2 archive configuration. No financial/escrow data paths
 * are used; only current game history and diagnostic logs are collected.
 * Credentials stay server-side and are never included in archive status.
 */
export function resolveForensicArchiveConfig(env = process.env) {
    const bucket = String(env.R2_BUCKET_NAME || env.WHEELWIN_R2_BUCKET_NAME || "").trim();
    const accountId = String(env.R2_ACCOUNT_ID || "").trim();
    const accessKeyId = String(env.R2_ACCESS_KEY_ID || "").trim();
    const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || "").trim();
    const endpoint = String(env.R2_ENDPOINT || "").trim();
    const r2Configured = Boolean(bucket && accessKeyId && secretAccessKey && (endpoint || accountId));
    const enabled = String(env.FORENSIC_ARCHIVE_ENABLED ?? "true").toLowerCase() !== "false";
    // A failed upload must never extend or alter the five-minute room deadline.
    const required = String(env.FORENSIC_ARCHIVE_REQUIRED ?? "false").toLowerCase() === "true";
    const maxUploadAttempts = Number.parseInt(env.FORENSIC_ARCHIVE_MAX_UPLOAD_ATTEMPTS ?? "5", 10);
    // Railway provides the mounted persistent volume path automatically.
    // Store ZIPs and retry status there, not on the ephemeral application disk.
    const volumeRoot = String(env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();

    return Object.freeze({
        enabled,
        required,
        bucket,
        prefix: String(env.R2_FORENSIC_PREFIX || "forensic-archives").replace(/^\/+|\/+$/g, ""),
        stagingDir: String(env.FORENSIC_ARCHIVE_STAGING_DIR || (volumeRoot ? join(volumeRoot, "r2-archive-staging") : join(process.cwd(), "data", "archive-staging"))).trim(),
        sessionHistoryDir: String(env.SESSION_HISTORY_DIR || (volumeRoot ? join(volumeRoot, "session-history") : join(process.cwd(), "data", "session-history"))).trim(),
        diagnosticLogsDir: String(env.DIAGNOSTIC_LOGS_DIR || join(process.cwd(), "logs", "games")).trim(),
        accountId,
        accessKeyId,
        secretAccessKey,
        endpoint,
        r2Configured,
        maxUploadAttempts: Number.isSafeInteger(maxUploadAttempts) && maxUploadAttempts > 0
            ? Math.min(maxUploadAttempts, 10)
            : 5
    });
}
