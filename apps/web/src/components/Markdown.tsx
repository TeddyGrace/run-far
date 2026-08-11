import { Fragment, type ReactNode } from "react";

/**
 * Minimal, dependency-free Markdown renderer for LLM chat output. Supports the subset the
 * coach actually produces: paragraphs, ordered/unordered lists, and inline bold, italic,
 * and inline code. Anything else renders as plain text.
 */
export function Markdown({ content }: { content: string }) {
  const blocks = splitBlocks(content);
  return (
    <div className="space-y-2">
      {blocks.map((block, i) => {
        if (block.type === "ul") {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "ol") {
          return (
            <ol key={i} className="list-decimal space-y-1 pl-5">
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ol>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}

type Block =
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] };

const UL_RE = /^\s*[-*]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;

function splitBlocks(content: string): Block[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "p", text: paragraph.join("\n").trim() });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    const ordered = OL_RE.test(line);
    const unordered = UL_RE.test(line);
    if (ordered || unordered) {
      flushParagraph();
      const type = ordered ? "ol" : "ul";
      const re = ordered ? OL_RE : UL_RE;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i]!)) {
        items.push(lines[i]!.match(re)![1]!);
        i++;
      }
      i--; // step back; the for-loop will advance past the last consumed line
      blocks.push({ type, items });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

const INLINE_RE = /(\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_|`([^`]+)`)/g;

function renderInline(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  INLINE_RE.lastIndex = 0;
  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(<Fragment key={key++}>{text.slice(lastIndex, match.index)}</Fragment>);
    }
    if (match[2] != null) {
      nodes.push(
        <strong key={key++} className="font-semibold text-ink-primary">
          {match[2]}
        </strong>,
      );
    } else if (match[3] != null || match[4] != null) {
      nodes.push(<em key={key++}>{match[3] ?? match[4]}</em>);
    } else if (match[5] != null) {
      nodes.push(
        <code key={key++} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]">
          {match[5]}
        </code>,
      );
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(<Fragment key={key++}>{text.slice(lastIndex)}</Fragment>);
  }
  return nodes;
}
