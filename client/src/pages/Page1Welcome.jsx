import { useState } from "react";

import GameLayout from "../layouts/GameLayout";

import InfoPanel from "../components/InfoPanel";

import DocumentManager from "../components/document/DocumentManager";

import TestnetWarningOverlay from "../components/TestnetWarningOverlay";

import { useLanguage } from "../context/LanguageContext";

import { DOCUMENTS } from "../utils/documents";

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

         >

            <InfoPanel

                 activeItem={activeItem}

                 onSelect={setActiveItem}

                 >

                 <DocumentManager

                 document={activeItem}

                 />

            </InfoPanel>

        </GameLayout>

        <TestnetWarningOverlay />

        </>

    );

}
