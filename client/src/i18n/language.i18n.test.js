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

test("supported languages include English, Spanish, and Portuguese", () => {
    assert.deepEqual(
        SUPPORTED_LANGUAGES.map((language) => language.code),
        ["en", "es", "pt"]
    );
    assert.equal(DEFAULT_LANGUAGE_CODE, "en");
    assert.equal(getLanguageLabel("en"), "English");
    assert.equal(getLanguageLabel("es"), "Español");
    assert.equal(getLanguageLabel("pt"), "Português");
    assert.equal(isSupportedLanguageCode("en"), true);
    assert.equal(isSupportedLanguageCode("es"), true);
    assert.equal(isSupportedLanguageCode("pt"), true);
    assert.equal(isSupportedLanguageCode("ru"), false);
    assert.equal(isSupportedLanguageCode("unknown"), false);
    assert.equal(isSupportedLanguageCode("invalid"), false);
});

test("English, Spanish, and Portuguese catalogs have matching key coverage", () => {
    assert.ok(TRANSLATIONS.en);
    assert.ok(TRANSLATIONS.es);
    assert.ok(TRANSLATIONS.pt);
    assert.equal(TRANSLATIONS.ru, undefined);

    const enKeys = Object.keys(TRANSLATIONS.en).sort();
    const esKeys = Object.keys(TRANSLATIONS.es).sort();
    const ptKeys = Object.keys(TRANSLATIONS.pt).sort();

    assert.equal(enKeys.length, 154);
    assert.equal(esKeys.length, 154);
    assert.equal(ptKeys.length, 154);
    assert.deepEqual(esKeys, enKeys);
    assert.deepEqual(ptKeys, enKeys);

    assert.match(TRANSLATIONS.en["page.welcome.title"], /WHEELWIN/i);
    assert.match(TRANSLATIONS.es["page.welcome.title"], /WHEELWIN/i);
    assert.match(TRANSLATIONS.pt["page.welcome.title"], /WHEELWIN/i);
    assert.match(TRANSLATIONS.pt["payment.confirmInWallet"], /Telegram Wallet/i);
    assert.match(TRANSLATIONS.pt["setup.oneGram"], /GRAM/);
    assert.match(TRANSLATIONS.pt["room.roomId"], /ID da sala/i);
    assert.notEqual(
        TRANSLATIONS.pt["common.next"],
        TRANSLATIONS.en["common.next"]
    );
});

test("translate falls back to English for missing keys and unknown languages", () => {
    assert.equal(translate("en", "common.next"), "NEXT");
    assert.equal(translate("es", "common.next"), "SIGUIENTE");
    assert.equal(translate("pt", "common.next"), "PRÓXIMO");

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
    assert.equal(translate("pt", "missing.key"), "missing.key");
});

test("translate interpolates placeholders in English, Spanish, and Portuguese", () => {
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
        translate("pt", "matrix.waitingCount", { submitted: 1, required: 2 }),
        "Aguardando jogadores… 1/2"
    );
});

test("storage supports English, Spanish, and Portuguese and migrates invalid codes", () => {
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

    saveStoredLanguageCode("pt");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "pt");
    assert.equal(loadStoredLanguageCode(), "pt");

    saveStoredLanguageCode("en");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "en");
    assert.equal(loadStoredLanguageCode(), "en");

    memory.set(LANGUAGE_STORAGE_KEY, "ru");
    assert.equal(loadStoredLanguageCode(), "en");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "en");

    memory.set(LANGUAGE_STORAGE_KEY, "unknown");
    assert.equal(loadStoredLanguageCode(), "en");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "en");

    memory.set(LANGUAGE_STORAGE_KEY, "pt");
    saveStoredLanguageCode("xx");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "pt");
});
