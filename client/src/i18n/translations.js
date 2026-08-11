/**
 * R6.6 — UI string catalogs keyed by language code.
 * Add a new object under TRANSLATIONS to support another language.
 */
export const TRANSLATIONS = Object.freeze({
    en: Object.freeze({
        "common.next": "NEXT",
        "common.back": "BACK",
        "common.finish": "FINISH",
        "common.loadingDocument": "Loading document...",
        "common.documentNotFound": "Document not found.",

        "menu.welcome": "WELCOME",
        "menu.rules": "RULES",
        "menu.faq": "FAQ",
        "menu.privacy": "PRIVACY",
        "menu.terms": "TERMS",
        "menu.news": "NEWS",
        "menu.links": "LINKS",
        "menu.changelog": "CHANGELOG",

        "page.welcome.title": "WELCOME TO WHEELWIN",
        "page.lobby.title": "CREATE OR JOIN ROOM",
        "page.setup.title": "PLAYER SETUP",
        "page.matrix.title": "SECRET MATRIX",
        "page.verify.title": "VERIFY",
        "page.payment.title": "PAYMENT",
        "page.result.title": "GAME FINISHED",
        "page.result.closesIn": "Page closes in: {seconds}",

        "setup.yourLanguage": "YOUR LANGUAGE",
        "setup.nickname": "INPUT YOUR NICKNAME",
        "setup.age": "HOW OLD ARE YOU?",
        "setup.ageHint": "You must be between {min} and {max} years old.",
        "setup.baseStake": "BASE STAKE",
        "setup.sectors": "SECTORS",
        "setup.arrangement": "ARRANGEMENT",
        "setup.colorSector1": "COLOR FOR SECTOR 1",
        "setup.colorSector2": "COLOR FOR SECTOR 2",
        "setup.oneGram": "1 GRAM",
        "setup.tenGram": "10 GRAM",
        "setup.oneSector": "1 SECTOR",
        "setup.twoSectors": "2 SECTORS",
        "setup.together": "TOGETHER",
        "setup.separate": "SEPARATE"
    }),

    ru: Object.freeze({
        "common.next": "ДАЛЕЕ",
        "common.back": "НАЗАД",
        "common.finish": "ЗАВЕРШИТЬ",
        "common.loadingDocument": "Загрузка документа...",
        "common.documentNotFound": "Документ не найден.",

        "menu.welcome": "ГЛАВНАЯ",
        "menu.rules": "ПРАВИЛА",
        "menu.faq": "FAQ",
        "menu.privacy": "КОНФИДЕНЦИАЛЬНОСТЬ",
        "menu.terms": "УСЛОВИЯ",
        "menu.news": "НОВОСТИ",
        "menu.links": "ССЫЛКИ",
        "menu.changelog": "ИЗМЕНЕНИЯ",

        "page.welcome.title": "ДОБРО ПОЖАЛОВАТЬ В WHEELWIN",
        "page.lobby.title": "СОЗДАТЬ ИЛИ ВОЙТИ В КОМНАТУ",
        "page.setup.title": "НАСТРОЙКА ИГРОКА",
        "page.matrix.title": "СЕКРЕТНАЯ МАТРИЦА",
        "page.verify.title": "ПРОВЕРКА",
        "page.payment.title": "ОПЛАТА",
        "page.result.title": "ИГРА ЗАВЕРШЕНА",
        "page.result.closesIn": "Страница закроется через: {seconds}",

        "setup.yourLanguage": "ВАШ ЯЗЫК",
        "setup.nickname": "ВВЕДИТЕ НИКНЕЙМ",
        "setup.age": "СКОЛЬКО ВАМ ЛЕТ?",
        "setup.ageHint": "Вам должно быть от {min} до {max} лет.",
        "setup.baseStake": "БАЗОВАЯ СТАВКА",
        "setup.sectors": "СЕКТОРЫ",
        "setup.arrangement": "РАСПОЛОЖЕНИЕ",
        "setup.colorSector1": "ЦВЕТ СЕКТОРА 1",
        "setup.colorSector2": "ЦВЕТ СЕКТОРА 2",
        "setup.oneGram": "1 GRAM",
        "setup.tenGram": "10 GRAM",
        "setup.oneSector": "1 СЕКТОР",
        "setup.twoSectors": "2 СЕКТОРА",
        "setup.together": "ВМЕСТЕ",
        "setup.separate": "РАЗДЕЛЬНО"
    })
});

export function translate(languageCode, key, vars = null) {

    const catalog = TRANSLATIONS[languageCode] ?? TRANSLATIONS.en;

    let text = catalog[key] ?? TRANSLATIONS.en[key] ?? key;

    if (vars && typeof text === "string") {

        for (const [name, value] of Object.entries(vars)) {

            text = text.replaceAll(`{${name}}`, String(value));

        }

    }

    return text;

}
