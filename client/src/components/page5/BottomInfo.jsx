import { useLanguage } from "../../context/LanguageContext";

export default function BottomInfo() {

    const { t } = useLanguage();

    return (

        <div className="bottomInfo">

            <div className="bottomInfo__section">

                <div className="bottomInfo__title">

                    {t("infobar.roomId")}

                </div>

                <div className="bottomInfo__value">

                    ABCD1234

                </div>

            </div>

            <div className="bottomInfo__section">

                <div className="bottomInfo__title">

                    {t("infobar.players")}

                </div>

                <div className="bottomInfo__value">

                    3 / 3

                </div>

            </div>

            <div className="bottomInfo__section">

                <div className="bottomInfo__title">

                    {t("infobar.gameTimer")}

                </div>

                <div className="bottomInfo__value">

                    09:00

                </div>

            </div>

        </div>

    );

}
