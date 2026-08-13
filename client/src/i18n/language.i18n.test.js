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

test("supported languages include English only", () => {
    assert.deepEqual(
        SUPPORTED_LANGUAGES.map((language) => language.code),
        ["en"]
    );
    assert.equal(DEFAULT_LANGUAGE_CODE, "en");
    assert.equal(getLanguageLabel("en"), "English");
    assert.equal(isSupportedLanguageCode("en"), true);
    assert.equal(isSupportedLanguageCode("ru"), false);
    assert.equal(isSupportedLanguageCode("unknown"), false);
    assert.equal(isSupportedLanguageCode("invalid"), false);
    assert.equal(isSupportedLanguageCode("es"), false);
});

test("English catalog remains the single source of truth", () => {
    assert.ok(TRANSLATIONS.en);
    assert.equal(TRANSLATIONS.ru, undefined);
    assert.equal(Object.keys(TRANSLATIONS.en).length, 154);

    assert.match(TRANSLATIONS.en["page.welcome.title"], /WHEELWIN/i);
    assert.match(TRANSLATIONS.en["page.lobby.title"], /CREATE OR JOIN/i);
    assert.match(TRANSLATIONS.en["setup.nickname"], /NICKNAME/i);
    assert.match(TRANSLATIONS.en["matrix.title"], /Secret Matrix/i);
    assert.match(TRANSLATIONS.en["verify.waitingForPlayers"], /Waiting for players/i);
    assert.match(TRANSLATIONS.en["payment.connectWallet"], /CONNECT TELEGRAM WALLET/i);
    assert.match(TRANSLATIONS.en["game.youMustWin"], /YOU MUST WIN/i);
    assert.match(TRANSLATIONS.en["result.youReceived"], /You received/i);
    assert.match(TRANSLATIONS.en["infobar.roomId"], /ROOM ID/i);
});

test("translate falls back to English for missing keys and unknown languages", () => {
    assert.equal(translate("en", "common.next"), "NEXT");

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
});

test("translate interpolates placeholders", () => {
    assert.equal(
        translate("en", "setup.ageHint", { min: 18, max: 100 }),
        "You must be between 18 and 100 years old."
    );

    assert.equal(
        translate("en", "matrix.waitingCount", { submitted: 1, required: 2 }),
        "Waiting for players… 1/2"
    );
});

test("storage migrates removed Russian and rejects unknown codes", () => {
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

    memory.set(LANGUAGE_STORAGE_KEY, "ru");
    assert.equal(loadStoredLanguageCode(), "en");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "en");

    memory.set(LANGUAGE_STORAGE_KEY, "unknown");
    assert.equal(loadStoredLanguageCode(), "en");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "en");

    memory.set(LANGUAGE_STORAGE_KEY, "invalid");
    assert.equal(loadStoredLanguageCode(), "en");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "en");

    saveStoredLanguageCode("en");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "en");

    memory.set(LANGUAGE_STORAGE_KEY, "en");
    saveStoredLanguageCode("ru");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "en");

    saveStoredLanguageCode("xx");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "en");
});
