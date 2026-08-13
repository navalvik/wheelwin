/**
 * R6.6 / R17.6 — Supported UI languages.
 * Codes are stable; labels are display-only. Never derived from browser/OS/IP.
 * English remains the fallback language.
 */
export const LANGUAGE_STORAGE_KEY = "wheelwin.language";

export const DEFAULT_LANGUAGE_CODE = "en";

export const SUPPORTED_LANGUAGES = Object.freeze([
    Object.freeze({ code: "en", label: "English" }),
    Object.freeze({ code: "es", label: "Español" }),
    Object.freeze({ code: "pt", label: "Português" }),
    Object.freeze({ code: "fr", label: "Français" }),
    Object.freeze({ code: "zh", label: "中文" })
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
