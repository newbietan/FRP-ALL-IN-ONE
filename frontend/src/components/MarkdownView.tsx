import React from 'react';

interface MarkdownViewProps {
  content: string;
}

export const MarkdownView: React.FC<MarkdownViewProps> = ({ content }) => {
  const renderInline = (text: string): React.ReactNode[] => {
    const parts: React.ReactNode[] = [];
    const regex = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.substring(lastIndex, match.index));
      }
      const token = match[0];
      if (token.startsWith('`') && token.endsWith('`')) {
        parts.push(
          <code key={match.index} className="bg-slate-200/80 text-[#006782] font-mono px-1.5 py-0.5 rounded text-[11px] font-medium border border-slate-300/50">
            {token.slice(1, -1)}
          </code>
        );
      } else if (token.startsWith('**') && token.endsWith('**')) {
        parts.push(
          <strong key={match.index} className="font-bold text-slate-800">
            {token.slice(2, -2)}
          </strong>
        );
      } else if (token.startsWith('[') && token.includes('](')) {
        const linkMatch = token.match(/\[([^\]]+)\]\(([^)]+)\)/);
        if (linkMatch) {
          parts.push(
            <a key={match.index} href={linkMatch[2]} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-medium">
              {linkMatch[1]}
            </a>
          );
        } else {
          parts.push(token);
        }
      } else {
        parts.push(token);
      }
      lastIndex = match.index + token.length;
    }
    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }
    return parts.length > 0 ? parts : [text];
  };

  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      elements.push(
        <pre key={`code-${i}`} className="bg-slate-900 text-slate-100 p-3 rounded-lg font-mono text-xs overflow-x-auto my-2 border border-slate-800">
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    const isTableDelimiter = (str: string) => /^\|?(\s*:?-+:?\s*\|)+\s*$/.test(str.trim());

    if (trimmed.startsWith('|') && trimmed.endsWith('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const headerCells = trimmed
        .split('|')
        .slice(1, -1)
        .map((c: string) => c.trim());
      i += 2;
      const bodyRows: string[][] = [];

      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        const cells = lines[i]
          .trim()
          .split('|')
          .slice(1, -1)
          .map((c: string) => c.trim());
        bodyRows.push(cells);
        i++;
      }

      elements.push(
        <div key={`table-${i}`} className="my-2.5 overflow-x-auto border border-slate-200 rounded-xl shadow-sm bg-white">
          <table className="w-full text-xs text-left border-collapse">
            <thead className="bg-slate-100/90 text-slate-800 font-semibold border-b border-slate-200">
              <tr>
                {headerCells.map((h: string, hIdx: number) => (
                  <th key={hIdx} className="px-3 py-2 font-sans">
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {bodyRows.map((row: string[], rIdx: number) => (
                <tr key={rIdx} className="hover:bg-slate-50/80 transition-colors">
                  {row.map((cell: string, cIdx: number) => (
                    <td key={cIdx} className="px-3 py-2 text-slate-700">
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (trimmed.startsWith('#### ')) {
      elements.push(
        <h5 key={`h4-${i}`} className="font-bold text-xs text-slate-800 mt-2 mb-1">
          {renderInline(trimmed.slice(5))}
        </h5>
      );
      i++;
      continue;
    }
    if (trimmed.startsWith('### ')) {
      elements.push(
        <h4 key={`h3-${i}`} className="font-bold text-xs text-slate-900 mt-2.5 mb-1.5 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-primary" />
          <span>{renderInline(trimmed.slice(4))}</span>
        </h4>
      );
      i++;
      continue;
    }
    if (trimmed.startsWith('## ')) {
      elements.push(
        <h3 key={`h2-${i}`} className="font-bold text-sm text-slate-900 mt-3 mb-1.5 pb-1 border-b border-slate-200 flex items-center gap-2">
          <span>{renderInline(trimmed.slice(3))}</span>
        </h3>
      );
      i++;
      continue;
    }
    if (trimmed.startsWith('# ')) {
      elements.push(
        <h2 key={`h1-${i}`} className="font-bold text-base text-slate-900 mt-3 mb-2">
          {renderInline(trimmed.slice(2))}
        </h2>
      );
      i++;
      continue;
    }

    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const listItems: string[] = [];
      while (i < lines.length && (lines[i].trim().startsWith('- ') || lines[i].trim().startsWith('* '))) {
        listItems.push(lines[i].trim().slice(2));
        i++;
      }
      elements.push(
        <ul key={`list-${i}`} className="list-disc list-inside space-y-1 my-1.5 text-xs text-slate-700 leading-relaxed">
          {listItems.map((item: string, lIdx: number) => (
            <li key={lIdx} className="pl-1">
              <span>{renderInline(item)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    if (/^\d+\.\s/.test(trimmed)) {
      const listItems: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
        listItems.push(lines[i].trim().replace(/^\d+\.\s/, ''));
        i++;
      }
      elements.push(
        <ol key={`olist-${i}`} className="list-decimal list-inside space-y-1 my-1.5 text-xs text-slate-700 leading-relaxed">
          {listItems.map((item: string, lIdx: number) => (
            <li key={lIdx} className="pl-1">
              <span>{renderInline(item)}</span>
            </li>
          ))}
        </ol>
      );
      continue;
    }

    if (trimmed.startsWith('> ')) {
      elements.push(
        <blockquote key={`quote-${i}`} className="border-l-2 border-primary/50 pl-3 py-1 my-1.5 text-xs text-slate-600 bg-slate-100/50 rounded-r">
          {renderInline(trimmed.slice(2))}
        </blockquote>
      );
      i++;
      continue;
    }

    elements.push(
      <p key={`p-${i}`} className="text-xs text-slate-700 leading-relaxed my-1">
        {renderInline(trimmed)}
      </p>
    );
    i++;
  }

  return <div className="markdown-content text-left space-y-1">{elements}</div>;
};
