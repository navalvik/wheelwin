import PanelShell from "./shared/PanelShell";
import EmptyState from "./shared/EmptyState";

export default function SettingsPanel() {

    return (

        <PanelShell title="Settings" subtitle="Reserved">

            <EmptyState
                title="Reserved for a later stage"
                detail="Developer preferences and R6.1 access settings will land here."
            />

        </PanelShell>

    );

}
