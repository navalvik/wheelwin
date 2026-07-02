import "../styles/infoMenu.css";

import { DOCUMENT_MENU } from "../utils/documents";

export default function InfoMenu({

    activeItem,

    onSelect

}){

    return(

        <nav className="infoMenu">

            {

                DOCUMENT_MENU.map(item => (

                    <button

                        key={item.id}

                        className={

                            activeItem===item.id

                                ? "menuButton active"

                                : "menuButton"

                        }

                        onClick={() => onSelect(item.id)}

                    >

                        {item.title}

                    </button>

                ))

            }

        </nav>

    );

}