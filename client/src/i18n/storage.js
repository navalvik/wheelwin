import {
    DEFAULT_LANGUAGE_CODE,
    LANGUAGE_STORAGE_KEY,
    isSupportedLanguageCode
} from "./languages";

/**
 * R6.6 — Persist / restore explicit user language choice only.
 * Never reads navigator.language, locale, OS, IP, or country.
 */
export function loadStoredLanguageCode() {

    try {

        const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);

        if (isSupportedLanguageCode(stored)) {

            return stored;

        }

    } catch {

        // Storage unavailable — fall through to default.
    }

    return DEFAULT_LANGUAGE_CODE;

}

export function saveStoredLanguageCode(code) {

    if (!isSupportedLanguageCode(code)) {

        return;

    }

    try {

        window.localStorage.setItem(LANGUAGE_STORAGE_KEY, code);

    } catch {

        // Ignore quota / private-mode failures; in-memory choice still applies.
    }

}
