import { useEffect, useState } from "react";

import MarkdownViewer from "../MarkdownViewer";

import { useLanguage } from "../../context/LanguageContext";

export default function DocumentManager({ document }) {

    const { languageCode, t } = useLanguage();

    const [content, setContent] = useState("");

    const [loading, setLoading] = useState(true);

    const [error, setError] = useState(false);

    useEffect(() => {

        async function loadDocument() {

            try {

                setLoading(true);

                setError(false);

                // Prefer language-specific docs when present; fall back to default.
                const localizedPath = `/docs/${languageCode}/${document}.md`;

                const defaultPath = `/docs/${document}.md`;

                let response = await fetch(localizedPath);

                if (!response.ok) {

                    response = await fetch(defaultPath);

                }

                if (!response.ok) {

                    throw new Error("Document not found");

                }

                const text = await response.text();

                setContent(text);

            }

            catch {

                setError(true);

            }

            finally {

                setLoading(false);

            }

        }

        loadDocument();

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
