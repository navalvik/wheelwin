import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import "../styles/markdown.css";

export default function MarkdownViewer({ content }) {

    return (

        <div className="markdownViewer">

            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
            >
                {content}
            </ReactMarkdown>

        </div>

    );

}