import { useEffect, useState } from "react";

import MarkdownViewer from "../MarkdownViewer";

export default function DocumentManager({ document }) {

    const [content, setContent] = useState("");

    const [loading, setLoading] = useState(true);

    const [error, setError] = useState(false);

    useEffect(() => {

        async function loadDocument() {

            try {

                setLoading(true);

                setError(false);

                const response = await fetch(`/docs/${document}.md`);

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

    }, [document]);

    if (loading) {

        return (

            <div className="documentStatus">

                Loading document...

            </div>

        );

    }

    if (error) {

        return (

            <div className="documentStatus">

                Document not found.

            </div>

        );

    }

    return (

        <MarkdownViewer

            content={content}

        />

    );

}