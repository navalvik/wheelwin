import PanelShell from "./shared/PanelShell";
import EmptyState from "./shared/EmptyState";

/**
 * R17.9F.2 — Placeholder panels for future Configuration sections.
 */
export default function ConfigurationPlaceholderPanel({
    title,
    subtitle,
    detail
}) {

    return (

        <PanelShell title={title} subtitle={subtitle}>

            <EmptyState
                title="Coming soon"
                detail={detail}
            />

        </PanelShell>

    );

}
