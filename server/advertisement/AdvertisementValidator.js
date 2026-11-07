/**
 * R14.2 — AdvertisementValidator.
 * Format / size / filename / URL / quota checks only. No I/O side effects.
 */

import { basename } from "node:path";

import {
    ADVERTISEMENT_FILENAME_PATTERN,
    ADVERTISEMENT_LIMITS,
    ALLOWED_IMAGE_EXTENSIONS,
    FORBIDDEN_URL_SCHEMES
} from "./advertisementTypes.js";

export class AdvertisementValidationError extends Error {

    constructor(code, message) {

        super(message);

        this.name = "AdvertisementValidationError";
        this.code = code;

    }

}

/**
 * Sanitize a client-supplied filename.
 * Returns basename-only, path-safe name or throws.
 */
export function sanitizeAdvertisementFilename(rawFilename) {

    if (typeof rawFilename !== "string" || rawFilename.trim() === "") {

        throw new AdvertisementValidationError(
            "INVALID_FILENAME",
            "Filename is required"
        );

    }

    const trimmed = rawFilename.trim();

    if (
        trimmed.includes("\0")
        || trimmed.includes("..")
        || /[/\\]/.test(trimmed)
    ) {

        throw new AdvertisementValidationError(
            "PATH_TRAVERSAL",
            "Filename must not contain path separators or traversal"
        );

    }

    const name = basename(trimmed);

    if (name !== trimmed || name === "." || name === "..") {

        throw new AdvertisementValidationError(
            "PATH_TRAVERSAL",
            "Filename must be a simple basename"
        );

    }

    const match = name.match(ADVERTISEMENT_FILENAME_PATTERN);

    if (!match) {

        throw new AdvertisementValidationError(
            "INVALID_FILENAME",
            "Filename must match {priority}_{slug}.{jpg|jpeg|png|webp|gif}"
        );

    }

    const priority = Number.parseInt(match[1], 10);
    const slug = match[2];
    const extension = match[3].toLowerCase();

    if (!Number.isFinite(priority) || priority < 0) {

        throw new AdvertisementValidationError(
            "INVALID_PRIORITY",
            "Filename priority must be a non-negative integer"
        );

    }

    if (!ALLOWED_IMAGE_EXTENSIONS.includes(extension)) {

        throw new AdvertisementValidationError(
            "INVALID_EXTENSION",
            `Unsupported extension: ${extension}`
        );

    }

    const sanitized = `${priority}_${slug}.${extension}`;

    return {
        filename: sanitized,
        priority,
        slug,
        extension
    };

}

export function validateAdvertisementFileBuffer({
    filename,
    bytes,
    currentTotalBytes = 0
}) {

    const sanitized = sanitizeAdvertisementFilename(filename);

    if (!Buffer.isBuffer(bytes)) {

        throw new AdvertisementValidationError(
            "INVALID_BUFFER",
            "File bytes must be a Buffer"
        );

    }

    const size = bytes.byteLength;

    if (size <= 0) {

        throw new AdvertisementValidationError(
            "EMPTY_FILE",
            "File is empty"
        );

    }

    if (sanitized.extension === "gif") {

        if (size > ADVERTISEMENT_LIMITS.MAX_GIF_BYTES) {

            throw new AdvertisementValidationError(
                "GIF_TOO_LARGE",
                `GIF exceeds ${ADVERTISEMENT_LIMITS.MAX_GIF_BYTES} bytes`
            );

        }

    } else if (size > ADVERTISEMENT_LIMITS.MAX_STATIC_BYTES) {

        throw new AdvertisementValidationError(
            "FILE_TOO_LARGE",
            `Image exceeds ${ADVERTISEMENT_LIMITS.MAX_STATIC_BYTES} bytes`
        );

    }

    const totalAfter = Number(currentTotalBytes) + size;

    if (totalAfter > ADVERTISEMENT_LIMITS.TOTAL_STORAGE_BYTES) {

        throw new AdvertisementValidationError(
            "STORAGE_QUOTA_EXCEEDED",
            `Total advertisement storage exceeds ${ADVERTISEMENT_LIMITS.TOTAL_STORAGE_BYTES} bytes`
        );

    }

    return {
        ...sanitized,
        sizeBytes: size,
        recommendedStatic: size <= ADVERTISEMENT_LIMITS.RECOMMENDED_STATIC_BYTES
    };

}

/**
 * Validate destination URL. Empty string is allowed (no destination yet).
 */
export function validateDestinationUrl(rawUrl) {

    if (rawUrl == null || String(rawUrl).trim() === "") {

        return "";

    }

    const url = String(rawUrl).trim();
    const lower = url.toLowerCase();

    for (const scheme of FORBIDDEN_URL_SCHEMES) {

        if (lower.startsWith(scheme)) {

            throw new AdvertisementValidationError(
                "DANGEROUS_URL_SCHEME",
                `URL scheme is not allowed: ${scheme}`
            );

        }

    }

    let parsed;

    try {

        parsed = new URL(url);

    } catch {

        throw new AdvertisementValidationError(
            "INVALID_URL",
            "Destination URL is not a valid absolute URL"
        );

    }

    const protocol = parsed.protocol.toLowerCase();

    if (protocol !== "https:" && protocol !== "http:") {

        throw new AdvertisementValidationError(
            "INVALID_URL_PROTOCOL",
            "Destination URL must use http: or https:"
        );

    }

    return url;

}

export const ADVERTISEMENT_DESTINATION_TYPES = Object.freeze({
    WEBSITE: "WEBSITE",
    TELEGRAM: "TELEGRAM"
});

/**
 * Legacy campaigns and requests without a type remain Website campaigns.
 */
export function normalizeAdvertisementDestinationType(rawType) {

    if (rawType == null || String(rawType).trim() === "") {

        return ADVERTISEMENT_DESTINATION_TYPES.WEBSITE;

    }

    const type = String(rawType).trim().toUpperCase();

    if (Object.values(ADVERTISEMENT_DESTINATION_TYPES).includes(type)) {

        return type;

    }

    throw new AdvertisementValidationError(
        "INVALID_DESTINATION_TYPE",
        "Destination type must be Website or Telegram"
    );

}

function validateTelegramToken(value, label) {

    if (
        typeof value !== "string"
        || value.length < 1
        || value.length > 64
        || !/^[A-Za-z0-9_-]+$/.test(value)
    ) {

        throw new AdvertisementValidationError(
            "INVALID_TELEGRAM_LINK",
            `Telegram ${label} is invalid`
        );

    }

    return value;

}

function normalizeTelegramQuery(searchParams) {

    const result = new URLSearchParams();

    for (const [key, value] of searchParams.entries()) {

        if (key !== "start" && key !== "startgroup") {

            throw new AdvertisementValidationError(
                "INVALID_TELEGRAM_LINK",
                "Telegram links may only include start or startgroup parameters"
            );

        }

        if (result.has(key)) {

            throw new AdvertisementValidationError(
                "INVALID_TELEGRAM_LINK",
                `Telegram ${key} parameter may only appear once`
            );

        }

        result.set(key, validateTelegramToken(value, key));

    }

    return result.toString();

}

/**
 * Accept only t.me links (or explicitly supported Telegram deep links) and
 * return a safe HTTPS URL suitable for both browsers and Telegram.WebApp.
 */
export function validateTelegramDestinationUrl(rawUrl) {

    if (rawUrl == null || String(rawUrl).trim() === "") {

        throw new AdvertisementValidationError(
            "INVALID_TELEGRAM_LINK",
            "Telegram link is required"
        );

    }

    const value = String(rawUrl).trim();
    let parsed;

    try {

        parsed = new URL(value);

    } catch {

        throw new AdvertisementValidationError(
            "INVALID_TELEGRAM_LINK",
            "Telegram link must be a supported t.me or tg:// link"
        );

    }

    let pathname;
    let query;

    if (parsed.protocol === "tg:") {

        if (parsed.username || parsed.password || parsed.port || parsed.hash) {

            throw new AdvertisementValidationError(
                "INVALID_TELEGRAM_LINK",
                "Telegram deep link is not supported"
            );

        }

        const queryParams = new URLSearchParams(parsed.search);

        if (parsed.hostname === "resolve") {

            const domain = validateTelegramToken(queryParams.get("domain"), "username");

            if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(domain)) {

                throw new AdvertisementValidationError(
                    "INVALID_TELEGRAM_LINK",
                    "Telegram username is invalid"
                );

            }

            queryParams.delete("domain");
            pathname = `/${domain}`;
            query = normalizeTelegramQuery(queryParams);

        } else if (parsed.hostname === "join") {

            const invites = queryParams.getAll("invite");
            const invite = validateTelegramToken(invites[0], "invite code");

            if (
                invites.length !== 1
                || [...queryParams.keys()].some((key) => key !== "invite")
            ) {

                throw new AdvertisementValidationError(
                    "INVALID_TELEGRAM_LINK",
                    "Telegram invite deep link contains unsupported parameters"
                );

            }

            pathname = `/+${invite}`;
            query = "";

        } else {

            throw new AdvertisementValidationError(
                "INVALID_TELEGRAM_LINK",
                "Only tg://resolve and tg://join links are supported"
            );

        }

        return `https://t.me${pathname}${query ? `?${query}` : ""}`;

    }

    if (
        parsed.protocol !== "https:"
        || parsed.hostname.toLowerCase() !== "t.me"
        || parsed.username
        || parsed.password
        || parsed.port
        || parsed.hash
    ) {

        throw new AdvertisementValidationError(
            "INVALID_TELEGRAM_LINK",
            "Telegram links must use the https://t.me domain"
        );

    }

    const path = parsed.pathname;

    if (/^\/\+[A-Za-z0-9_-]+$/.test(path)) {

        if (parsed.search) {

            throw new AdvertisementValidationError(
                "INVALID_TELEGRAM_LINK",
                "Telegram invite links cannot include query parameters"
            );

        }

        return `https://t.me${path}`;

    }

    const joinMatch = path.match(/^\/joinchat\/([A-Za-z0-9_-]+)$/);

    if (joinMatch) {

        if (parsed.search) {

            throw new AdvertisementValidationError(
                "INVALID_TELEGRAM_LINK",
                "Telegram invite links cannot include query parameters"
            );

        }

        return `https://t.me/joinchat/${joinMatch[1]}`;

    }

    const usernameMatch = path.match(/^\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/);

    if (!usernameMatch) {

        throw new AdvertisementValidationError(
            "INVALID_TELEGRAM_LINK",
            "Telegram link must point to a public bot, channel, group, or invite"
        );

    }

    const normalizedQuery = normalizeTelegramQuery(parsed.searchParams);

    return `https://t.me/${usernameMatch[1]}${normalizedQuery ? `?${normalizedQuery}` : ""}`;

}

export function validateAdvertisementDestination(rawUrl, rawType) {

    const type = normalizeAdvertisementDestinationType(rawType);

    return {
        destinationType: type,
        destinationUrl: type === ADVERTISEMENT_DESTINATION_TYPES.TELEGRAM
            ? validateTelegramDestinationUrl(rawUrl)
            : validateDestinationUrl(rawUrl)
    };

}

export class AdvertisementValidator {

    sanitizeFilename(rawFilename) {

        return sanitizeAdvertisementFilename(rawFilename);

    }

    validateFile({ filename, bytes, currentTotalBytes = 0 }) {

        return validateAdvertisementFileBuffer({
            filename,
            bytes,
            currentTotalBytes
        });

    }

    validateDestinationUrl(rawUrl) {

        return validateDestinationUrl(rawUrl);

    }

    validateTelegramDestinationUrl(rawUrl) {

        return validateTelegramDestinationUrl(rawUrl);

    }

    validateDestination(rawUrl, destinationType) {

        return validateAdvertisementDestination(rawUrl, destinationType);

    }

}
