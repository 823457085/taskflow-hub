import React from 'react';
import { parseInlineTokens, parseMarkdownBlocks, parsePlainUrlTokens, type InlineToken, type MarkdownBlock } from './markdownLite';
import './MarkdownPreview.css';

function renderTokens(tokens: InlineToken[]): React.ReactNode {
  return tokens.map((tok, idx) => {
    if (tok.type === 'code') {
      return <code key={idx} className="tf-md-inline-code">{tok.text}</code>;
    }
    if (tok.type === 'strong') {
      return <strong key={idx}>{renderTokens(parsePlainUrlTokens(tok.text))}</strong>;
    }
    if (tok.type === 'link') {
      return (
        <a key={idx} className="tf-content-link" href={tok.href} target="_blank" rel="noreferrer noopener" onClick={event => event.stopPropagation()}>
          {tok.text}
        </a>
      );
    }
    return <React.Fragment key={idx}>{tok.text}</React.Fragment>;
  });
}

function renderInline(text: string) {
  return renderTokens(parseInlineTokens(text));
}

export function LinkifiedText({ text }: { text: string }) {
  return <>{renderTokens(parsePlainUrlTokens(text))}</>;
}

export const MarkdownPreview: React.FC<{ content: string; blocks?: MarkdownBlock[] }> = ({ content, blocks }) => {
  const parsed = blocks ?? parseMarkdownBlocks(content);
  if (!parsed.length) {
    return <pre className="tf-code-panel">{content}</pre>;
  }

  return (
    <div className="tf-md-preview" aria-label="Markdown 结构化预览">
      {parsed.map((block, idx) => {
        switch (block.type) {
          case 'heading': {
            const TagName = block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5';
            return (
              <TagName key={idx} className={`tf-md-heading tf-md-h${block.level}`}>
                {renderInline(block.text)}
              </TagName>
            );
          }
          case 'code':
            return (
              <pre key={idx} className="tf-md-code-block">
                {block.lang && <div className="tf-md-code-lang">{block.lang}</div>}
                <code>{block.code}</code>
              </pre>
            );
          case 'blockquote':
            return (
              <blockquote key={idx} className="tf-md-quote">
                {block.lines.map((line, lIdx) => (
                  <p key={lIdx}>{renderInline(line)}</p>
                ))}
              </blockquote>
            );
          case 'checklist':
            return (
              <ul key={idx} className="tf-md-checklist">
                {block.items.map((item, cIdx) => (
                  <li key={cIdx} className={item.checked ? 'tf-md-check-done' : ''}>
                    <span className={`tf-md-checkbox ${item.checked ? 'is-checked' : ''}`} aria-hidden="true">
                      {item.checked ? '✓' : ''}
                    </span>
                    <span>{renderInline(item.text)}</span>
                  </li>
                ))}
              </ul>
            );
          case 'ul':
            return (
              <ul key={idx} className="tf-md-list">
                {block.items.map((item, lIdx) => (
                  <li key={lIdx}>{renderInline(item)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={idx} className="tf-md-list">
                {block.items.map((item, lIdx) => (
                  <li key={lIdx}>{renderInline(item)}</li>
                ))}
              </ol>
            );
          case 'table':
            return (
              <div key={idx} className="tf-md-table-wrap">
                <table className="tf-md-table">
                  <thead>
                    <tr>
                      {block.headers.map((h, hIdx) => (
                        <th key={hIdx}>{renderInline(h)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rIdx) => (
                      <tr key={rIdx}>
                        {block.headers.map((_, cIdx) => (
                          <td key={cIdx}>{renderInline(row[cIdx] || '')}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'hr':
            return <hr key={idx} className="tf-md-hr" />;
          case 'paragraph':
          default:
            return (
              <p key={idx} className="tf-md-p">
                {block.text.split('\n').map((line, pIdx) => (
                  <React.Fragment key={pIdx}>
                    {pIdx > 0 && <br />}
                    {renderInline(line)}
                  </React.Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
};
