import "../styles/infoMenu.css";

import { useLanguage } from "../context/LanguageContext";

import { DOCUMENT_MENU } from "../utils/documents";

const MENU_TITLE_KEYS = Object.freeze({
    welcome: "menu.welcome",
    rules: "menu.rules",
    faq: "menu.faq",
    privacy: "menu.privacy",
    terms: "menu.terms",
    news: "menu.news",
    links: "menu.links",
    changelog: "menu.changelog"
});

export default function InfoMenu({

    activeItem,

    onSelect

}){

    const { t } = useLanguage();

    return(

        <nav className="infoMenu">

            {

                DOCUMENT_MENU.map(item => (

                    <button

                        key={item.id}

                        type="button"

                        className={

                            activeItem===item.id

                                ? "menuButton active"

                                : "menuButton"

                        }

                        onClick={() => onSelect(item.id)}

                    >

                        {t(MENU_TITLE_KEYS[item.id] ?? item.title)}

                    </button>

                ))

            }

        </nav>

    );

}
