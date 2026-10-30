import GameLayout from "../layouts/GameLayout";
import { useLanguage } from "../context/LanguageContext";
import "../styles/noFriends.css";

export default function EntryModePage({ onFriends, onNoFriends, onBack }) {

    const { t } = useLanguage();

    return <GameLayout
        message={t("page.entryMode.title")}
        backEnabled
        onBack={onBack}
        showNextButton={false}
    >
        <div className="noFriendsPage noFriendsPage--entry">
            <button className="noFriendsChoice noFriendsChoice--friends" onClick={onFriends}>
                {t("noFriends.withFriends")}
            </button>
            <button className="noFriendsChoice" onClick={onNoFriends}>
                {t("noFriends.withoutFriends")}
            </button>
        </div>
    </GameLayout>;

}
