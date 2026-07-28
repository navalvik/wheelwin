import { useState } from "react";

import { useDeveloperAuth } from "./DeveloperAuthProvider";
import { formatTimestamp } from "./formatters";

/**
 * R6.1 — Developer Login / session controls in the console header.
 */
export default function DeveloperLoginPanel() {

    const {
        authEnabled,
        requiresLogin,
        session,
        environment,
        error,
        status,
        login,
        logout
    } = useDeveloperAuth();

    const [username, setUsername] = useState("");

    const [password, setPassword] = useState("");

    const [submitting, setSubmitting] = useState(false);

    async function onSubmit(event) {

        event.preventDefault();

        setSubmitting(true);

        await login({ username, password });

        setSubmitting(false);

        setPassword("");

    }

    if (!authEnabled) {

        return (

            <div className="devConsole__loginPanel">

                <span className="devConsole__loginLabel">

                    Developer Access

                </span>

                <span className="devConsole__loginHint">

                    Auth disabled · {environment}

                </span>

            </div>

        );

    }

    if (requiresLogin) {

        return (

            <form className="devConsole__loginForm" onSubmit={onSubmit}>

                <div className="devConsole__loginFormTitle">

                    Administrator Login

                </div>

                <label className="devConsole__loginField">

                    <span>

                        Username

                    </span>

                    <input
                        name="username"
                        autoComplete="username"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        required
                    />

                </label>

                <label className="devConsole__loginField">

                    <span>

                        Password

                    </span>

                    <input
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        required
                    />

                </label>

                {error && (

                    <p className="devConsole__loginError">

                        {error}

                    </p>

                )}

                <button
                    type="submit"
                    className="devConsole__loginSubmit"
                    disabled={submitting || status === "authenticating"}
                >

                    {submitting ? "Signing in…" : "Sign in"}

                </button>

            </form>

        );

    }

    return (

        <div className="devConsole__sessionPanel">

            <div className="devConsole__sessionRow">

                <span className="devConsole__sessionName">

                    {session?.username ?? "Developer"}

                </span>

                <span className="devConsole__sessionRole">

                    {session?.role ?? "Developer"}

                </span>

            </div>

            <div className="devConsole__sessionMeta">

                <span>

                    {environment}

                </span>

                <span>

                    Expires {formatTimestamp(session?.expiresAt)}

                </span>

            </div>

            <button
                type="button"
                className="devConsole__logoutButton"
                onClick={() => logout()}
            >

                Logout

            </button>

        </div>

    );

}
