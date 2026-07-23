import InfoMenu from "./InfoMenu";
import LanguageSelector from "./LanguageSelector";

import "../styles/infoPanel.css";

export default function InfoPanel({

    activeItem,

    onSelect,

    children

}){

    return(

        <div className="infoPanel">

            <aside className="infoPanelMenu">

                <LanguageSelector />

                <InfoMenu

                    activeItem={activeItem}

                    onSelect={onSelect}

                />

            </aside>

            <section className="infoPanelContent">

                {children}

            </section>

        </div>

    );

}
