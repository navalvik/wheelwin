import { useEffect, useState } from "react";

import MarkdownViewer from "../MarkdownViewer";

import { useLanguage } from "../../context/LanguageContext";

/**
 * Vite SPA fallback serves index.html with HTTP 200 for missing public files.
 * Reject that so we never render the app shell as "documentation".
 */
function isSpaHtmlFallback(text) {

    if (typeof text !== "string") {

        return true;

    }

    const trimmed = text.trimStart().slice(0, 64).toLowerCase();

    return trimmed.startsWith("<!doctype html")
        || trimmed.startsWith("<html");

}

async function fetchMarkdownDocument(path) {

    const response = await fetch(path);

    if (!response.ok) {

        return null;

    }

    const text = await response.text();

    if (isSpaHtmlFallback(text)) {

        return null;

    }

    return text;

}

function resolveDocumentCandidates(languageCode, documentId) {

    const localizedPath = `/docs/${languageCode}/${documentId}.md`;

    const defaultPath = `/docs/${documentId}.md`;

    // English lives at /docs/<page>.md today; try /docs/en/ first for future use.
    if (languageCode === "en") {

        return [localizedPath, defaultPath];

    }

    return [localizedPath, defaultPath];

}

export default function DocumentManager({ document }) {

    const { languageCode, t } = useLanguage();

    const [content, setContent] = useState("");

    const [loading, setLoading] = useState(true);

    const [error, setError] = useState(false);

    useEffect(() => {

        let cancelled = false;

        async function loadDocument() {

            try {

                setLoading(true);

                setError(false);

                const candidates = resolveDocumentCandidates(
                    languageCode,
                    document
                );

                let text = null;

                for (const path of candidates) {

                    text = await fetchMarkdownDocument(path);

                    if (text != null) {

                        break;

                    }

                }

                if (cancelled) {

                    return;

                }

                if (text == null) {

                    throw new Error("Document not found");

                }

                setContent(text);

            }

            catch {

                if (!cancelled) {

                    setError(true);

                }

            }

            finally {

                if (!cancelled) {

                    setLoading(false);

                }

            }

        }

        loadDocument();

        return () => {

            cancelled = true;

        };

    }, [document, languageCode]);

    if (loading) {

        return (

            <div className="documentStatus">

                {t("common.loadingDocument")}

            </div>

        );

    }

    if (error) {

        return (

            <div className="documentStatus">

                {t("common.documentNotFound")}

            </div>

        );

    }

    return (

        <MarkdownViewer

            content={content}

        />

    );

}
