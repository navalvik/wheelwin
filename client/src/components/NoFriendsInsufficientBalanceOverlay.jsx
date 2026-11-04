import { useLanguage } from "../context/LanguageContext";

export default function NoFriendsInsufficientBalanceOverlay({
    minimumBalanceGram,
    baseStake,
    onDismiss
}) {
    const { t } = useLanguage();

    return <div
        className="noFriendsBalanceOverlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="noFriendsBalanceTitle"
    >
        <div className="noFriendsBalanceOverlay__panel">
            <h2 id="noFriendsBalanceTitle">{t("noFriends.insufficientBalance.title")}</h2>
            <p>{t("noFriends.insufficientBalance.body", {
                minimum: minimumBalanceGram,
                stake: baseStake
            })}</p>
            <button type="button" onClick={onDismiss}>
                {t("noFriends.insufficientBalance.ok")}
            </button>
        </div>
    </div>;
}
