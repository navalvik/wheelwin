import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState
} from "react";

import {
    DEFAULT_LANGUAGE_CODE,
    getLanguageLabel,
    isSupportedLanguageCode
} from "../i18n/languages";

import {
    loadStoredLanguageCode,
    saveStoredLanguageCode
} from "../i18n/storage";

import { translate } from "../i18n/translations";

const LanguageContext = createContext(null);

/**
 * R6.6 — App language is an explicit user choice only.
 * Default English on first launch; restored from localStorage thereafter.
 */
export function LanguageProvider({ children }) {

    const [languageCode, setLanguageCodeState] = useState(() => (
        loadStoredLanguageCode()
    ));

    const setLanguageCode = useCallback((nextCode) => {

        if (!isSupportedLanguageCode(nextCode)) {

            return;

        }

        setLanguageCodeState(nextCode);

        saveStoredLanguageCode(nextCode);

    }, []);

    useEffect(() => {

        document.documentElement.lang = languageCode;

    }, [languageCode]);

    const t = useCallback((key, vars) => (
        translate(languageCode, key, vars)
    ), [languageCode]);

    const value = useMemo(() => ({
        languageCode,
        languageLabel: getLanguageLabel(languageCode),
        setLanguageCode,
        t
    }), [languageCode, setLanguageCode, t]);

    return (

        <LanguageContext.Provider value={value}>

            {children}

        </LanguageContext.Provider>

    );

}

export function useLanguage() {

    const context = useContext(LanguageContext);

    if (!context) {

        throw new Error("useLanguage must be used within LanguageProvider");

    }

    return context;

}

export { DEFAULT_LANGUAGE_CODE };
