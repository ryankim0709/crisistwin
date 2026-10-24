// Minimal Markdown subset rendered as React elements: headings, paragraphs, bullet and
// numbered lists, **bold**, *italic* and `code`. Model text is never parsed as HTML; links
// and raw tags stay literal text.
import type { ReactNode } from "react";

// No underscore emphasis: bare snake_case field names must stay intact.
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;

function inline(text: string, keyBase: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**"))
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`"))
      return <code key={key}>{part.slice(1, -1)}</code>;
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*"))
      return <em key={key}>{part.slice(1, -1)}</em>;
    return part;
  });
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] };

function parse(source: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "para", text: para.join(" ") });
    para = [];
  };
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (!line) {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
    } else if (bullet || numbered) {
      flush();
      const ordered = Boolean(numbered);
      const item = (bullet ?? numbered)![1];
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(item);
      else blocks.push({ kind: "list", ordered, items: [item] });
    } else if (!para.length && blocks[blocks.length - 1]?.kind === "list" && raw.startsWith("  ")) {
      const list = blocks[blocks.length - 1] as Extract<Block, { kind: "list" }>;
      list.items[list.items.length - 1] += ` ${line}`;
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks;
}

export function Markdown({ source }: { source: string }) {
  return (
    <>
      {parse(source).map((block, i) => {
        const key = `b${i}`;
        if (block.kind === "heading") {
          // Answer headings sit under the panel's own section title, so start at h3.
          const Tag = block.level <= 2 ? "h3" : "h4";
          return <Tag key={key}>{inline(block.text, key)}</Tag>;
        }
        if (block.kind === "list") {
          const Tag = block.ordered ? "ol" : "ul";
          return (
            <Tag key={key}>
              {block.items.map((item, j) => (
                <li key={j}>{inline(item, `${key}-${j}`)}</li>
              ))}
            </Tag>
          );
        }
        return <p key={key}>{inline(block.text, key)}</p>;
      })}
    </>
  );
}
