import { useEffect, useState } from "react";

import { fetchMaintenanceStatus } from "../developerAuthApi";
import { useDeveloperAuth } from "../DeveloperAuthProvider";
import PanelShell from "./shared/PanelShell";
import EmptyState from "./shared/EmptyState";

export default function MaintenancePanel() {

    const { accessToken } = useDeveloperAuth();

    const [status, setStatus] = useState(null);

    useEffect(() => {

        let cancelled = false;

        async function load() {

            if (!accessToken) {

                return;

            }

            try {

                const next = await fetchMaintenanceStatus(accessToken);

                if (!cancelled) {

                    setStatus(next);

                }

            } catch {

                if (!cancelled) {

                    setStatus(null);

                }

            }

        }

        load();

        return () => {

            cancelled = true;

        };

    }, [accessToken]);

    return (

        <PanelShell
            title="Maintenance Mode"
            subtitle="Prepared for a future stage — no runtime behaviour"
        >

            <EmptyState
                title={status?.state ?? "INACTIVE"}
                detail={status?.message
                    ?? "MaintenanceService architecture is prepared. Activation is not available yet."}
            />

        </PanelShell>

    );

}
