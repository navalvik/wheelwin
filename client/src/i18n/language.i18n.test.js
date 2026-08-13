import test from "node:test";
import assert from "node:assert/strict";

import {
    DEFAULT_LANGUAGE_CODE,
    LANGUAGE_STORAGE_KEY,
    SUPPORTED_LANGUAGES,
    getLanguageLabel,
    isSupportedLanguageCode
} from "./languages.js";

import {
    TRANSLATIONS,
    translate
} from "./translations.js";

import {
    loadStoredLanguageCode,
    saveStoredLanguageCode
} from "./storage.js";

test("supported languages include English and Spanish", () => {
    assert.deepEqual(
        SUPPORTED_LANGUAGES.map((language) => language.code),
        ["en", "es"]
    );
    assert.equal(DEFAULT_LANGUAGE_CODE, "en");
    assert.equal(getLanguageLabel("en"), "English");
    assert.equal(getLanguageLabel("es"), "Español");
    assert.equal(isSupportedLanguageCode("en"), true);
    assert.equal(isSupportedLanguageCode("es"), true);
    assert.equal(isSupportedLanguageCode("ru"), false);
    assert.equal(isSupportedLanguageCode("unknown"), false);
    assert.equal(isSupportedLanguageCode("invalid"), false);
});

test("English and Spanish catalogs have matching key coverage", () => {
    assert.ok(TRANSLATIONS.en);
    assert.ok(TRANSLATIONS.es);
    assert.equal(TRANSLATIONS.ru, undefined);

    const enKeys = Object.keys(TRANSLATIONS.en).sort();
    const esKeys = Object.keys(TRANSLATIONS.es).sort();

    assert.equal(enKeys.length, 154);
    assert.equal(esKeys.length, 154);
    assert.deepEqual(esKeys, enKeys);

    assert.match(TRANSLATIONS.en["page.welcome.title"], /WHEELWIN/i);
    assert.match(TRANSLATIONS.es["page.welcome.title"], /WHEELWIN/i);
    assert.match(TRANSLATIONS.es["payment.confirmInWallet"], /Telegram Wallet/i);
    assert.match(TRANSLATIONS.es["setup.oneGram"], /GRAM/);
    assert.notEqual(
        TRANSLATIONS.es["common.next"],
        TRANSLATIONS.en["common.next"]
    );
});

test("translate falls back to English for missing keys and unknown languages", () => {
    assert.equal(translate("en", "common.next"), "NEXT");
    assert.equal(translate("es", "common.next"), "SIGUIENTE");

    assert.equal(
        translate("ru", "common.next"),
        TRANSLATIONS.en["common.next"]
    );

    assert.equal(
        translate("unknown", "common.next"),
        TRANSLATIONS.en["common.next"]
    );

    assert.equal(
        translate("invalid", "common.next"),
        TRANSLATIONS.en["common.next"]
    );

    assert.equal(translate("en", "missing.key"), "missing.key");
    assert.equal(translate("es", "missing.key"), "missing.key");
});

test("translate interpolates placeholders in English and Spanish", () => {
    assert.equal(
        translate("en", "setup.ageHint", { min: 18, max: 100 }),
        "You must be between 18 and 100 years old."
    );

    assert.equal(
        translate("es", "setup.ageHint", { min: 18, max: 100 }),
        "Debes tener entre 18 y 100 años."
    );

    assert.equal(
        translate("en", "matrix.waitingCount", { submitted: 1, required: 2 }),
        "Waiting for players… 1/2"
    );

    assert.equal(
        translate("es", "matrix.waitingCount", { submitted: 1, required: 2 }),
        "Esperando jugadores… 1/2"
    );
});

test("storage supports English and Spanish and migrates invalid codes", () => {
    const memory = new Map();

    globalThis.window = {
        localStorage: {
            getItem(key) {
                return memory.has(key) ? memory.get(key) : null;
            },
            setItem(key, value) {
                memory.set(key, String(value));
            }
        }
    };

    memory.set(LANGUAGE_STORAGE_KEY, "en");
    assert.equal(loadStoredLanguageCode(), "en");

    saveStoredLanguageCode("es");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "es");
    assert.equal(loadStoredLanguageCode(), "es");

    saveStoredLanguageCode("en");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "en");
    assert.equal(loadStoredLanguageCode(), "en");

    memory.set(LANGUAGE_STORAGE_KEY, "ru");
    assert.equal(loadStoredLanguageCode(), "en");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "en");

    memory.set(LANGUAGE_STORAGE_KEY, "unknown");
    assert.equal(loadStoredLanguageCode(), "en");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "en");

    memory.set(LANGUAGE_STORAGE_KEY, "es");
    saveStoredLanguageCode("xx");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "es");
});
