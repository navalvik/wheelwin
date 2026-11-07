const TELEGRAM_QUERY_KEYS = new Set(["start", "startgroup"]);

function validateToken(value) {

    return typeof value === "string"
        && value.length > 0
        && value.length <= 64
        && /^[A-Za-z0-9_-]+$/.test(value);

}

function normalizeQuery(searchParams) {

    const normalized = new URLSearchParams();

    for (const [key, value] of searchParams.entries()) {

        if (!TELEGRAM_QUERY_KEYS.has(key) || normalized.has(key)) {

            return null;

        }

        if (!validateToken(value)) {

            return null;

        }

        normalized.set(key, value);

    }

    return normalized.toString();

}

/**
 * Return a safe https://t.me link for supported Telegram destinations, or
 * null for arbitrary hosts, schemes, and unsupported deep-link formats.
 */
export function normalizeTelegramAdvertisementUrl(rawUrl) {

    if (typeof rawUrl !== "string" || !rawUrl.trim()) {

        return null;

    }

    let parsed;

    try {

        parsed = new URL(rawUrl.trim());

    } catch {

        return null;

    }

    if (parsed.protocol === "tg:") {

        if (parsed.username || parsed.password || parsed.port || parsed.hash) {

            return null;

        }

        const params = new URLSearchParams(parsed.search);

        if (parsed.hostname === "resolve") {

            const username = params.get("domain");

            if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username ?? "")) {

                return null;

            }

            params.delete("domain");
            const query = normalizeQuery(params);

            if (query === null) {

                return null;

            }

            return `https://t.me/${username}${query ? `?${query}` : ""}`;

        }

        if (parsed.hostname === "join") {

            const invites = params.getAll("invite");
            const invite = invites[0];

            if (
                invites.length !== 1
                || !validateToken(invite)
                || [...params.keys()].some((key) => key !== "invite")
            ) {

                return null;

            }

            return `https://t.me/+${invite}`;

        }

        return null;

    }

    if (
        parsed.protocol !== "https:"
        || parsed.hostname.toLowerCase() !== "t.me"
        || parsed.username
        || parsed.password
        || parsed.port
        || parsed.hash
    ) {

        return null;

    }

    if (/^\/\+[A-Za-z0-9_-]+$/.test(parsed.pathname)) {

        if (parsed.search) {

            return null;

        }

        return `https://t.me${parsed.pathname}`;

    }

    const invite = parsed.pathname.match(/^\/joinchat\/([A-Za-z0-9_-]+)$/);

    if (invite) {

        return parsed.search ? null : `https://t.me/joinchat/${invite[1]}`;

    }

    const username = parsed.pathname.match(/^\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/);

    if (!username) {

        return null;

    }

    const query = normalizeQuery(parsed.searchParams);

    return query === null
        ? null
        : `https://t.me/${username[1]}${query ? `?${query}` : ""}`;

}
