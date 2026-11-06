import { useState } from "react";

import GameLayout from "../layouts/GameLayout";

import InfoPanel from "../components/InfoPanel";

import DocumentManager from "../components/document/DocumentManager";

import NetworkWarningOverlay from "../components/NetworkWarningOverlay";


import { useLanguage } from "../context/LanguageContext";

import { DOCUMENTS } from "../utils/documents";

import { SHOW_MAINNET_SWITCH } from "../config/features";

export default function Page1Welcome({

    onNext

}){

    const { t } = useLanguage();

    const [activeItem, setActiveItem] = useState(

    DOCUMENTS.WELCOME

);

    return(

        <>

         <GameLayout

           message={t("page.welcome.title")}

           nextEnabled={true}

            onNext={onNext}

           showMainnetSwitch={SHOW_MAINNET_SWITCH}

          >

            <InfoPanel

                 activeItem={activeItem}

                 onSelect={setActiveItem}

                 >

                 {activeItem === DOCUMENTS.ADVERTISING ? (

                    <Page1AdvertisingContact />

                 ) : (

                    <DocumentManager

                        document={activeItem}

                    />

                 )}

            </InfoPanel>

        </GameLayout>

        <NetworkWarningOverlay />

        </>

    );

}

export function Page1AdvertisingContact() {

    return (

        <section
            className="advertisingContact"
            aria-labelledby="advertisingContactTitle"
        >

            <h2 id="advertisingContactTitle">Advertising &amp; Partnerships</h2>

            <a href="mailto:advertising.wheelwin@outlook.com">
                advertising.wheelwin@outlook.com
            </a>

        </section>

    );

}
