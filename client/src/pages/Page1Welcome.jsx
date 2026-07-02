import { useState } from "react";

import GameLayout from "../layouts/GameLayout";

import InfoPanel from "../components/InfoPanel";

import DocumentManager from "../components/document/DocumentManager";

import { DOCUMENTS } from "../utils/documents";

export default function Page1Welcome({

    onNext

}){

    const [activeItem, setActiveItem] = useState(

    DOCUMENTS.WELCOME

);

    return(

         <GameLayout

           message="WELCOME TO WHEELWIN"

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

    );

}