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

const LOCALE_CODES = ["en", "es", "pt", "fr", "zh"];

test("supported languages include English, Spanish, Portuguese, French, and Chinese", () => {
    assert.deepEqual(
        SUPPORTED_LANGUAGES.map((language) => language.code),
        LOCALE_CODES
    );
    assert.equal(DEFAULT_LANGUAGE_CODE, "en");
    assert.equal(getLanguageLabel("en"), "English");
    assert.equal(getLanguageLabel("es"), "Español");
    assert.equal(getLanguageLabel("pt"), "Português");
    assert.equal(getLanguageLabel("fr"), "Français");
    assert.equal(getLanguageLabel("zh"), "中文");
    for (const code of LOCALE_CODES) {
        assert.equal(isSupportedLanguageCode(code), true);
    }
    assert.equal(isSupportedLanguageCode("ru"), false);
    assert.equal(isSupportedLanguageCode("unknown"), false);
    assert.equal(isSupportedLanguageCode("invalid"), false);
});

test("all player locale catalogs have matching key coverage", () => {
    assert.ok(TRANSLATIONS.en);
    assert.ok(TRANSLATIONS.es);
    assert.ok(TRANSLATIONS.pt);
    assert.ok(TRANSLATIONS.fr);
    assert.ok(TRANSLATIONS.zh);
    assert.equal(TRANSLATIONS.ru, undefined);

    const enKeys = Object.keys(TRANSLATIONS.en).sort();
    assert.equal(enKeys.length, 170);

    for (const code of LOCALE_CODES) {
        const keys = Object.keys(TRANSLATIONS[code]).sort();
        assert.equal(keys.length, 170, `${code} key count`);
        assert.deepEqual(keys, enKeys, `${code} key parity`);
    }

    assert.match(TRANSLATIONS.en["page.welcome.title"], /WHEELWIN/i);
    assert.match(TRANSLATIONS.zh["page.welcome.title"], /WHEELWIN/i);
    assert.match(TRANSLATIONS.zh["payment.confirmInWallet"], /Telegram Wallet/i);
    assert.match(TRANSLATIONS.zh["setup.oneGram"], /GRAM/);
    assert.match(TRANSLATIONS.zh["room.roomId"], /房间 ID/);
    assert.notEqual(
        TRANSLATIONS.zh["common.next"],
        TRANSLATIONS.en["common.next"]
    );
});

test("translate falls back to English for missing keys and unknown languages", () => {
    assert.equal(translate("en", "common.next"), "NEXT");
    assert.equal(translate("es", "common.next"), "SIGUIENTE");
    assert.equal(translate("pt", "common.next"), "PRÓXIMO");
    assert.equal(translate("fr", "common.next"), "SUIVANT");
    assert.equal(translate("zh", "common.next"), "下一步");

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
    assert.equal(translate("zh", "missing.key"), "missing.key");
});

test("translate interpolates placeholders across locales", () => {
    assert.equal(
        translate("en", "setup.ageHint", { min: 18, max: 100 }),
        "You must be between 18 and 100 years old."
    );

    assert.equal(
        translate("zh", "setup.ageHint", { min: 18, max: 100 }),
        "你的年龄必须在 18 到 100 岁之间。"
    );

    assert.equal(
        translate("zh", "matrix.waitingCount", { submitted: 1, required: 2 }),
        "正在等待玩家… 1/2"
    );

    assert.equal(
        translate("zh", "player.you", { n: 2 }),
        "玩家 2 — 你"
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

    for (const code of LOCALE_CODES) {
        saveStoredLanguageCode(code);
        assert.equal(memory.get(LANGUAGE_STORAGE_KEY), code);
        assert.equal(loadStoredLanguageCode(), code);
    }

    saveStoredLanguageCode("en");
    assert.equal(loadStoredLanguageCode(), "en");

    memory.set(LANGUAGE_STORAGE_KEY, "ru");
    assert.equal(loadStoredLanguageCode(), "en");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "en");

    memory.set(LANGUAGE_STORAGE_KEY, "unknown");
    assert.equal(loadStoredLanguageCode(), "en");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "en");

    memory.set(LANGUAGE_STORAGE_KEY, "zh");
    saveStoredLanguageCode("xx");
    assert.equal(memory.get(LANGUAGE_STORAGE_KEY), "zh");
});
