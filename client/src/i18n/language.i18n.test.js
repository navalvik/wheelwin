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

test("supported languages include English, Spanish, Portuguese, and French", () => {
    assert.deepEqual(
        SUPPORTED_LANGUAGES.map((language) => language.code),
        ["en", "es", "pt", "fr"]
    );
    assert.equal(DEFAULT_LANGUAGE_CODE, "en");
    assert.equal(getLanguageLabel("en"), "English");
    assert.equal(getLanguageLabel("es"), "Español");
    assert.equal(getLanguageLabel("pt"), "Português");
    assert.equal(getLanguageLabel("fr"), "Français");
    assert.equal(isSupportedLanguageCode("en"), true);
    assert.equal(isSupportedLanguageCode("es"), true);
    assert.equal(isSupportedLanguageCode("pt"), true);
    assert.equal(isSupportedLanguageCode("fr"), true);
    assert.equal(isSupportedLanguageCode("ru"), false);
    assert.equal(isSupportedLanguageCode("unknown"), false);
    assert.equal(isSupportedLanguageCode("invalid"), false);
});

test("all player locale catalogs have matching key coverage", () => {
    assert.ok(TRANSLATIONS.en);
    assert.ok(TRANSLATIONS.es);
    assert.ok(TRANSLATIONS.pt);
    assert.ok(TRANSLATIONS.fr);
    assert.equal(TRANSLATIONS.ru, undefined);

    const enKeys = Object.keys(TRANSLATIONS.en).sort();
    const esKeys = Object.keys(TRANSLATIONS.es).sort();
    const ptKeys = Object.keys(TRANSLATIONS.pt).sort();
    const frKeys = Object.keys(TRANSLATIONS.fr).sort();

    assert.equal(enKeys.length, 154);
    assert.equal(esKeys.length, 154);
    assert.equal(ptKeys.length, 154);
    assert.equal(frKeys.length, 154);
    assert.deepEqual(esKeys, enKeys);
    assert.deepEqual(ptKeys, enKeys);
    assert.deepEqual(frKeys, enKeys);

    assert.match(TRANSLATIONS.en["page.welcome.title"], /WHEELWIN/i);
    assert.match(TRANSLATIONS.fr["page.welcome.title"], /WHEELWIN/i);
    assert.match(TRANSLATIONS.fr["payment.confirmInWallet"], /Telegram Wallet/i);
    assert.match(TRANSLATIONS.fr["setup.oneGram"], /GRAM/);
    assert.match(TRANSLATIONS.fr["room.roomId"], /ID de salle/i);
    assert.notEqual(
        TRANSLATIONS.fr["common.next"],
        TRANSLATIONS.en["common.next"]
    );
});

test("translate falls back to English for missing keys and unknown languages", () => {
    assert.equal(translate("en", "common.next"), "NEXT");
    assert.equal(translate("es", "common.next"), "SIGUIENTE");
    assert.equal(translate("pt", "common.next"), "PRÓXIMO");
    assert.equal(translate("fr", "common.next"), "SUIVANT");

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
    assert.equal(translate("fr", "missing.key"), "missing.key");
});

test("translate interpolates placeholders across locales", () => {
    assert.equal(
        translate("en", "setup.ageHint", { min: 18, max: 100 }),
        "You must be between 18 and 100 years old."
    );

    assert.equal(
        translate("es", "setup.ageHint", { min: 18, max: 100 }),
        "Debes tener entre 18 y 100 años."
    );

    assert.equal(
        translate("pt", "setup.ageHint", { min: 18, max: 100 }),
        "Você deve ter entre 18 e 100 anos."
    );

    assert.equal(
        translate("fr", "setup.ageHint", { min: 18, max: 100 }),
        "Vous devez avoir entre 18 et 100 ans."
    );

    assert.equal(
        translate("fr", "matrix.waitingCount", { submitted: 1, required: 2 }),
        "En attente des joueurs… 1/2"
    );
});

test("storage supports all locales and migrates invalid codes", () => {
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
    assert.equal(loadStoredLanguageCode(), "es");

    saveStoredLanguageCode("pt");
    assert.equal(loadStoredLanguageCode(), "pt");

    saveStoredLanguageCode("fr");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "fr");
    assert.equal(loadStoredLanguageCode(), "fr");

    saveStoredLanguageCode("en");
    assert.equal(loadStoredLanguageCode(), "en");

    memory.set(LANGUAGE_STORAGE_KEY, "ru");
    assert.equal(loadStoredLanguageCode(), "en");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "en");

    memory.set(LANGUAGE_STORAGE_KEY, "unknown");
    assert.equal(loadStoredLanguageCode(), "en");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "en");

    memory.set(LANGUAGE_STORAGE_KEY, "fr");
    saveStoredLanguageCode("xx");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "fr");
});
