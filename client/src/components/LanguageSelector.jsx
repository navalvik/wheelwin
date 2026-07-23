import { SUPPORTED_LANGUAGES } from "../i18n/languages";

import { useLanguage } from "../context/LanguageContext";

import "../styles/languageSelector.css";

/**
 * R6.6 — Welcome-only language control. Does not navigate or open a page.
 */
export default function LanguageSelector() {

    const { languageCode, setLanguageCode } = useLanguage();

    return (

        <div className="languageSelector">

            <div
                className="languageSelector__title"
                aria-hidden="true"
            >
                🌐
            </div>

            <label className="languageSelector__label">

                <span className="languageSelector__srOnly">
                    Language
                </span>

                <select
                    className="languageSelector__select"
                    value={languageCode}
                    onChange={(event) => setLanguageCode(event.target.value)}
                >

                    {SUPPORTED_LANGUAGES.map((language) => (

                        <option
                            key={language.code}
                            value={language.code}
                        >
                            {language.label}
                        </option>

                    ))}

                </select>

            </label>

        </div>

    );

}
