"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownContentProps {
  content: string;
  isUser?: boolean;
}

export default function MarkdownContent({
  content,
  isUser = false,
}: MarkdownContentProps) {
  const textColor = isUser ? "#ffffff" : "#000716";
  const linkColor = isUser ? "#a3d4ff" : "#0972d3";
  const codeBg = isUser ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.06)";
  const codeBlockBg = isUser ? "rgba(0,0,0,0.25)" : "#f2f3f3";
  const borderColor = isUser ? "rgba(255,255,255,0.3)" : "#d5dbdb";

  return (
    <div
      className="md-content"
      style={{ color: textColor, lineHeight: 1.7, fontSize: 14 }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p style={{ margin: "6px 0" }}>{children}</p>
          ),
          h1: ({ children }) => (
            <h3
              style={{
                margin: "12px 0 6px",
                fontSize: 17,
                fontWeight: 700,
              }}
            >
              {children}
            </h3>
          ),
          h2: ({ children }) => (
            <h4
              style={{
                margin: "10px 0 4px",
                fontSize: 15,
                fontWeight: 700,
              }}
            >
              {children}
            </h4>
          ),
          h3: ({ children }) => (
            <h5
              style={{
                margin: "8px 0 4px",
                fontSize: 14,
                fontWeight: 700,
              }}
            >
              {children}
            </h5>
          ),
          strong: ({ children }) => (
            <strong style={{ fontWeight: 700 }}>{children}</strong>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: linkColor, textDecoration: "underline" }}
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul style={{ margin: "4px 0", paddingLeft: 20 }}>{children}</ul>
          ),
          ol: ({ children }) => (
            <ol style={{ margin: "4px 0", paddingLeft: 20 }}>{children}</ol>
          ),
          li: ({ children }) => (
            <li style={{ margin: "2px 0" }}>{children}</li>
          ),
          code: ({ className, children }) => {
            const isBlock = className?.startsWith("language-");
            if (isBlock) {
              return (
                <code
                  style={{
                    display: "block",
                    background: codeBlockBg,
                    borderRadius: 6,
                    padding: "10px 12px",
                    margin: "6px 0",
                    fontSize: 13,
                    fontFamily:
                      "'SF Mono', 'Fira Code', 'Fira Mono', Menlo, monospace",
                    overflowX: "auto",
                    whiteSpace: "pre",
                    lineHeight: 1.5,
                  }}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                style={{
                  background: codeBg,
                  borderRadius: 3,
                  padding: "1px 5px",
                  fontSize: 13,
                  fontFamily:
                    "'SF Mono', 'Fira Code', 'Fira Mono', Menlo, monospace",
                }}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => <>{children}</>,
          blockquote: ({ children }) => (
            <blockquote
              style={{
                borderLeft: `3px solid ${borderColor}`,
                margin: "6px 0",
                paddingLeft: 12,
                opacity: 0.9,
              }}
            >
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div style={{ overflowX: "auto", margin: "6px 0" }}>
              <table
                style={{
                  borderCollapse: "collapse",
                  width: "100%",
                  fontSize: 13,
                }}
              >
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th
              style={{
                border: `1px solid ${borderColor}`,
                padding: "6px 10px",
                fontWeight: 700,
                textAlign: "left",
                background: codeBg,
              }}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td
              style={{
                border: `1px solid ${borderColor}`,
                padding: "5px 10px",
              }}
            >
              {children}
            </td>
          ),
          hr: () => (
            <hr
              style={{
                border: "none",
                borderTop: `1px solid ${borderColor}`,
                margin: "8px 0",
              }}
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
