/**
 * Host-independent CORS origin validation.
 *
 * Explicit origins come from CLIENT_ORIGIN (comma-separated). Express and
 * Socket.IO both use createCorsOriginValidator / loadServerConfig.cors — one list.
 *
 * In development, localhost, 127.0.0.1, and private LAN IPs on any port are also
 * allowed so Vite clients work at http://192.168.x.x:5173 without listing every IP.
 * Production/staging require an explicit CLIENT_ORIGIN match.
 */

const LOCAL_ORIGIN_PATTERN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

const PRIVATE_LAN_ORIGIN_PATTERN = /^https?:\/\/(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d+)?$/;

function normalizeExplicitOrigins(clientOrigin) {

    if (Array.isArray(clientOrigin)) {

        return clientOrigin;

    }

    if (typeof clientOrigin === "string" && clientOrigin.trim() !== "") {

        return [clientOrigin.trim()];

    }

    return [];

}

function isDevelopmentEnv(nodeEnv) {

    return nodeEnv === "development" || nodeEnv === undefined || nodeEnv === null;

}

function isDevLocalOrigin(origin) {

    return LOCAL_ORIGIN_PATTERN.test(origin)
        || PRIVATE_LAN_ORIGIN_PATTERN.test(origin);

}

/**
 * @param {string|string[]|readonly string[]} clientOrigin
 * @param {string} [nodeEnv]
 * @returns {(origin: string|undefined, callback: (err: Error|null, allow?: boolean) => void) => void}
 */
export function createCorsOriginValidator(clientOrigin, nodeEnv = "development") {

    const explicitOrigins = normalizeExplicitOrigins(clientOrigin);

    const explicitSet = new Set(explicitOrigins);

    const allowDevLocal = isDevelopmentEnv(nodeEnv);

    return (origin, callback) => {

        if (!origin) {

            callback(null, true);

            return;

        }

        if (explicitSet.has(origin)) {

            callback(null, true);

            return;

        }

        if (allowDevLocal && isDevLocalOrigin(origin)) {

            callback(null, true);

            return;

        }

        // Deny without throwing — Express cors / Socket.IO expect (null, false).
        callback(null, false);

    };

}

export function isAllowedCorsOrigin(clientOrigin, nodeEnv, origin) {

    return new Promise((resolve) => {

        createCorsOriginValidator(clientOrigin, nodeEnv)(origin, (error, allowed) => {

            resolve(!error && allowed === true);

        });

    });

}
