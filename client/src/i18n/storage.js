import {
    DEFAULT_LANGUAGE_CODE,
    LANGUAGE_STORAGE_KEY,
    isSupportedLanguageCode
} from "./languages.js";

export { LANGUAGE_STORAGE_KEY };

/**
 * R6.6 — Persist / restore explicit user language choice only.
 * Never reads navigator.language, locale, OS, IP, or country.
 *
 * R17.2 — Migrates removed/invalid codes (e.g. legacy "ru") to English.
 */
export function loadStoredLanguageCode() {

    try {

        const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);

        if (isSupportedLanguageCode(stored)) {
            return stored;
        }

        // Persist migration so invalid values (including legacy "ru") do not linger.
        if (stored != null) {
            window.localStorage.setItem(LANGUAGE_STORAGE_KEY, DEFAULT_LANGUAGE_CODE);
        }

        return DEFAULT_LANGUAGE_CODE;

    } catch {

        return DEFAULT_LANGUAGE_CODE;

    }

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
