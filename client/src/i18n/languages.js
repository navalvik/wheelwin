/**
 * R6.6 / R17.2 — Supported UI languages.
 * Codes are stable; labels are display-only. Never derived from browser/OS/IP.
 */
export const LANGUAGE_STORAGE_KEY = "wheelwin.language";

export const DEFAULT_LANGUAGE_CODE = "en";

export const SUPPORTED_LANGUAGES = Object.freeze([
    Object.freeze({ code: "en", label: "English" })
]);

export function getLanguageByCode(code) {

    return SUPPORTED_LANGUAGES.find((entry) => entry.code === code) ?? null;

}

export function getLanguageLabel(code) {

    return getLanguageByCode(code)?.label
        ?? getLanguageByCode(DEFAULT_LANGUAGE_CODE).label;

}

export function isSupportedLanguageCode(code) {

    return SUPPORTED_LANGUAGES.some((entry) => entry.code === code);

}
