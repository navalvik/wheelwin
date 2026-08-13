/**
 * R16.8 — Advertisement Cloudflare R2 configuration (environment only).
 * Reuses forensic R2 credential env vars; advertising uses its own prefix.
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveAdvertisementR2Config(env = process.env) {

    const bucket = String(
        env.R2_BUCKET_NAME
            || env.WHEELWIN_R2_BUCKET_NAME
            || env.ADVERTISEMENT_R2_BUCKET_NAME
            || ""
    ).trim();

    const accountId = String(env.R2_ACCOUNT_ID || "").trim();
    const accessKeyId = String(env.R2_ACCESS_KEY_ID || "").trim();
    const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || "").trim();
    const endpoint = String(env.R2_ENDPOINT || "").trim();

    const prefix = String(
        env.ADVERTISEMENT_R2_PREFIX
            || env.R2_ADVERTISEMENT_PREFIX
            || "advertising"
    ).replace(/^\/+|\/+$/g, "");

    const r2Configured = Boolean(
        bucket
        && accessKeyId
        && secretAccessKey
        && (endpoint || accountId)
    );

    const forceLocal = String(
        env.ADVERTISEMENT_STORAGE_LOCAL ?? ""
    ).toLowerCase() === "true";

    const useR2 = r2Configured && !forceLocal;

    return Object.freeze({
        bucket,
        prefix,
        accountId,
        accessKeyId,
        secretAccessKey,
        endpoint,
        r2Configured,
        forceLocal,
        useR2,
        campaignsPrefix: `${prefix}/campaigns`,
        assetsPrefix: `${prefix}/assets`
    });

}
