import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ROOT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * R13.9F — Forensic archive + GCS configuration (environment only).
 */
export function resolveForensicArchiveConfig(env = process.env) {

    const bucket = String(
        env.GCS_FORENSIC_BUCKET
            || env.WHEELWIN_GCS_FORENSIC_BUCKET
            || ""
    ).trim();

    const enabled = String(env.FORENSIC_ARCHIVE_ENABLED ?? "true").toLowerCase()
        !== "false";

    const required = String(env.FORENSIC_ARCHIVE_REQUIRED ?? "").toLowerCase()
        === "true"
        || (bucket.length > 0
            && String(env.FORENSIC_ARCHIVE_REQUIRED ?? "auto").toLowerCase()
                !== "false");

    const stagingDir = String(
        env.FORENSIC_ARCHIVE_STAGING_DIR
            || join(process.cwd(), "data", "archive-staging")
    ).trim();

    const sessionHistoryDir = String(
        env.SESSION_HISTORY_DIR
            || join(process.cwd(), "data", "session-history")
    ).trim();

    const diagnosticLogsDir = String(
        env.DIAGNOSTIC_LOGS_DIR
            || join(process.cwd(), "logs", "games")
    ).trim();

    const tonFinancialDataDir = String(
        env.TON_FINANCIAL_DATA_DIR
            || env.WHEELWIN_FINANCIAL_DATA_DIR
            || join(SERVER_ROOT_DIR, "..", "data", "ton-financial")
    ).trim();

    const prefix = String(env.GCS_FORENSIC_PREFIX || "forensic-archives")
        .replace(/^\/+|\/+$/g, "");

    const credentialsJson = String(env.GCS_SERVICE_ACCOUNT_JSON || "").trim();

    const maxUploadAttempts = Number.parseInt(
        env.FORENSIC_ARCHIVE_MAX_UPLOAD_ATTEMPTS ?? "5",
        10
    );

    return Object.freeze({
        enabled,
        required,
        bucket,
        prefix,
        stagingDir,
        sessionHistoryDir,
        diagnosticLogsDir,
        tonFinancialDataDir,
        credentialsJson,
        maxUploadAttempts: Number.isFinite(maxUploadAttempts)
            && maxUploadAttempts > 0
            ? maxUploadAttempts
            : 5
    });

}
