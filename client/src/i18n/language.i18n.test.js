import assert from "node:assert/strict";
import {
    DEFAULT_LANGUAGE_CODE,
    isSupportedLanguageCode,
    getLanguageLabel
} from "../i18n/languages.js";
import { translate } from "../i18n/translations.js";

assert.equal(DEFAULT_LANGUAGE_CODE, "en");
assert.equal(isSupportedLanguageCode("en"), true);
assert.equal(isSupportedLanguageCode("ru"), true);
assert.equal(isSupportedLanguageCode("de"), false);
assert.equal(getLanguageLabel("ru"), "Русский");
assert.equal(getLanguageLabel("en"), "English");
assert.equal(translate("en", "setup.yourLanguage"), "YOUR LANGUAGE");
assert.equal(translate("ru", "setup.yourLanguage"), "ВАШ ЯЗЫК");
assert.equal(
    translate("en", "page.result.closesIn", { seconds: 5 }),
    "Page closes in: 5"
);
assert.equal(
    translate("ru", "page.result.closesIn", { seconds: 5 }),
    "Страница закроется через: 5"
);
assert.equal(
    translate("ru", "setup.ageHint", { min: 18, max: 99 }),
    "Вам должно быть от 18 до 99 лет."
);
assert.equal(
    translate("xx", "common.next"),
    "NEXT",
    "unknown language falls back to English"
);

console.log("language.i18n.test.js — all assertions passed");
