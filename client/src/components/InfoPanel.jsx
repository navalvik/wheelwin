import InfoMenu from "./InfoMenu";

import "../styles/infoPanel.css";

export default function InfoPanel({

    activeItem,

    onSelect,

    children

}){

    return(

        <div className="infoPanel">

            <aside className="infoPanelMenu">

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