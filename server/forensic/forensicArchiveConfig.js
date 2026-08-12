import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ROOT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * R13.9H — Forensic archive + Cloudflare R2 configuration (environment only).
 */
export function resolveForensicArchiveConfig(env = process.env) {

    const bucket = String(
        env.R2_BUCKET_NAME
            || env.WHEELWIN_R2_BUCKET_NAME
            || ""
    ).trim();

    const accountId = String(env.R2_ACCOUNT_ID || "").trim();
    const accessKeyId = String(env.R2_ACCESS_KEY_ID || "").trim();
    const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || "").trim();
    const endpoint = String(env.R2_ENDPOINT || "").trim();

    const r2Configured = Boolean(
        bucket
        && accessKeyId
        && secretAccessKey
        && (endpoint || accountId)
    );

    const enabled = String(env.FORENSIC_ARCHIVE_ENABLED ?? "true").toLowerCase()
        !== "false";

    const required = String(env.FORENSIC_ARCHIVE_REQUIRED ?? "").toLowerCase()
        === "true"
        || (r2Configured
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

    const prefix = String(
        env.R2_FORENSIC_PREFIX
            || env.GCS_FORENSIC_PREFIX
            || "forensic-archives"
    ).replace(/^\/+|\/+$/g, "");

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
        accountId,
        accessKeyId,
        secretAccessKey,
        endpoint,
        r2Configured,
        maxUploadAttempts: Number.isFinite(maxUploadAttempts)
            && maxUploadAttempts > 0
            ? maxUploadAttempts
            : 5
    });

}
