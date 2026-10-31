import { dc } from "kt-dc";
import { useTheme } from "vuetify";
import { ThemedView } from "@/components/ThemedView";

type GuideMarkdownProps = {
    source: string;
    compact?: boolean;
};

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

const inline = (value: string): string => {
    let html = escapeHtml(value);
    html = html.replace(/&lt;br\s*\/?&gt;/gi, "<br>");
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return html;
};

const splitTableRow = (line: string): string[] => {
    const trimmed = line.trim();
    const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
    const withoutEnd = inner.endsWith("|") ? inner.slice(0, -1) : inner;
    return withoutEnd.split("|").map((cell) => cell.trim());
};

const isTableSeparator = (line: string): boolean => /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");

export const GuideMarkdown = dc(
    (props: GuideMarkdownProps) => {
        const theme = useTheme();
        return () => {
            const source = props.source ?? "";
            const lines = source.split(/\r?\n/);
            const blocks: JSX.Element[] = [];
            let index = 0;
            let key = 0;

            const codeStyle = {
                margin: "10px 0",
                padding: "12px",
                borderRadius: "10px",
                background: "rgba(100,116,139,0.12)",
                overflowX: "auto" as const,
                fontSize: "12px",
                lineHeight: 1.6,
                direction: "ltr" as const,
                textAlign: "left" as const,
                whiteSpace: "pre" as const,
            };

            const renderTable = (rows: string[][]) => {
                const header = rows[0] ?? [];
                const body = rows.slice(1);
                return (
                    <div key={`table-${key++}`} style={{ overflowX: "auto", margin: "12px 0" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                            <thead>
                                <tr>
                                    {header.map((cell, cellIndex) => (
                                        <th
                                            key={`th-${cellIndex}`}
                                            style={{ textAlign: "start", padding: "9px 8px", borderBottom: "2px solid rgba(100,116,139,0.3)" }}
                                            innerHTML={inline(cell)}
                                        />
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {body.map((row, rowIndex) => (
                                    <tr key={`tr-${rowIndex}`}>
                                        {row.map((cell, cellIndex) => (
                                            <td
                                                key={`td-${rowIndex}-${cellIndex}`}
                                                style={{
                                                    padding: "9px 8px",
                                                    borderBottom: "1px solid rgba(100,116,139,0.18)",
                                                    verticalAlign: "top",
                                                    lineHeight: 1.55,
                                                }}
                                                innerHTML={inline(cell)}
                                            />
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                );
            };

            while (index < lines.length) {
                const line = lines[index] ?? "";
                const trimmed = line.trim();

                if (trimmed.length === 0) {
                    index += 1;
                    continue;
                }

                if (trimmed === "---" || trimmed === "***" || trimmed === "___") {
                    blocks.push(<hr key={`hr-${key++}`} style={{ border: 0, borderTop: "1px solid rgba(100,116,139,0.25)", margin: "16px 0" }} />);
                    index += 1;
                    continue;
                }

                if (trimmed.startsWith("```")) {
                    const language = trimmed.slice(3).trim();
                    const codeLines: string[] = [];
                    index += 1;
                    while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
                        codeLines.push(lines[index] ?? "");
                        index += 1;
                    }
                    index += 1;
                    blocks.push(
                        <div key={`code-${key++}`} style={{ margin: "10px 0" }}>
                            {language ? (
                                <div style={{ fontSize: "11px", opacity: 0.55, marginBottom: "2px", direction: "ltr" }}>{language}</div>
                            ) : null}
                            <pre style={codeStyle}>{codeLines.join("\n")}</pre>
                        </div>,
                    );
                    continue;
                }

                if (trimmed.startsWith("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1] ?? "")) {
                    const rows: string[][] = [splitTableRow(trimmed)];
                    index += 2;
                    while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
                        rows.push(splitTableRow(lines[index] ?? ""));
                        index += 1;
                    }
                    blocks.push(renderTable(rows));
                    continue;
                }

                if (trimmed.startsWith(">")) {
                    const quoteLines: string[] = [];
                    while (index < lines.length && (lines[index] ?? "").trim().startsWith(">")) {
                        quoteLines.push((lines[index] ?? "").replace(/^>\s?/, ""));
                        index += 1;
                    }
                    const quote = quoteLines.join("\n");
                    const critical = /CRITICAL|NEVER|WARNING|INCIDENT|GOLDEN RULE/i.test(quote);
                    blocks.push(
                        <div
                            key={`quote-${key++}`}
                            style={{
                                margin: "12px 0",
                                padding: "12px 14px",
                                borderRadius: "10px",
                                borderInlineStart: `5px solid ${critical ? theme.current.value.colors.error : theme.current.value.colors.primary}`,
                                background: critical ? "rgba(239,68,68,0.08)" : "rgba(15,107,255,0.06)",
                                fontSize: "13px",
                                lineHeight: 1.7,
                                whiteSpace: "pre-wrap",
                            }}
                            innerHTML={inline(quote)}
                        />,
                    );
                    continue;
                }

                const headingMatch = /^(#{1,4})\s+(.*)$/.exec(trimmed);
                if (headingMatch) {
                    const level = headingMatch[1]?.length ?? 3;
                    const text = headingMatch[2] ?? "";
                    const size = level <= 2 ? "21px" : level === 3 ? "18px" : "16px";
                    blocks.push(
                        <div
                            key={`heading-${key++}`}
                            style={{ margin: "18px 0 8px", fontWeight: 800, fontSize: size, lineHeight: 1.3 }}
                            innerHTML={inline(text)}
                        />,
                    );
                    index += 1;
                    continue;
                }

                const bulletMatch = /^[-*]\s+(.*)$/.exec(trimmed);
                const numberMatch = /^(\d+)\.\s+(.*)$/.exec(trimmed);
                if (bulletMatch || numberMatch) {
                    const ordered = Boolean(numberMatch);
                    const items: string[] = [];
                    while (index < lines.length) {
                        const candidate = (lines[index] ?? "").trim();
                        const match = ordered ? /^(\d+)\.\s+(.*)$/.exec(candidate) : /^[-*]\s+(.*)$/.exec(candidate);
                        if (!match) {
                            break;
                        }
                        items.push((ordered ? match[2] : match[1]) ?? "");
                        index += 1;
                    }
                    const ListTag = ordered ? "ol" : "ul";
                    blocks.push(
                        <ListTag key={`list-${key++}`} style={{ margin: "8px 0", paddingInlineStart: "24px", lineHeight: 1.7 }}>
                            {items.map((item, itemIndex) => (
                                <li key={`li-${itemIndex}`} innerHTML={inline(item)} />
                            ))}
                        </ListTag>,
                    );
                    continue;
                }

                const paragraph: string[] = [trimmed];
                index += 1;
                while (index < lines.length) {
                    const candidate = (lines[index] ?? "").trim();
                    if (
                        candidate.length === 0 ||
                        candidate.startsWith("#") ||
                        candidate.startsWith("```") ||
                        candidate.startsWith("|") ||
                        candidate.startsWith(">") ||
                        /^[-*]\s+/.test(candidate) ||
                        /^\d+\.\s+/.test(candidate)
                    ) {
                        break;
                    }
                    paragraph.push(candidate);
                    index += 1;
                }
                blocks.push(
                    <p
                        key={`p-${key++}`}
                        style={{
                            margin: "8px 0",
                            fontSize: props.compact ? "13px" : "14px",
                            lineHeight: 1.75,
                            whiteSpace: "pre-wrap",
                        }}
                        innerHTML={inline(paragraph.join(" "))}
                    />,
                );
            }

            return <ThemedView style={{ gap: "2px" }}>{blocks}</ThemedView>;
        };
    },
    { props: ["source", "compact"] as any },
);

export default GuideMarkdown;
