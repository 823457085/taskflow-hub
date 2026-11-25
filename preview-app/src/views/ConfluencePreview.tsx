import { createElement, Fragment, useMemo, type ReactNode } from 'react';
import { LinkifiedText } from './MarkdownPreview';
import { isSafeHttpUrl } from './markdownLite';
import './ConfluencePreview.css';

const DOCUMENT_TAG = /^(?:\s|<!--[\s\S]*?-->|<!doctype html\s*>|<\?xml[^>]*\?>)*<(?:ac:[a-z-]+|ri:[a-z-]+|html|body|article|section|div|p|h[1-6]|table|ol|ul|dl|pre|blockquote|br|hr|a|span|strong|img)(?=[\s/>])/i;
const CONTENT_TAGS = new Set([
  'div', 'p', 'span', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'sup', 'sub', 'caption',
]);
const OMITTED_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'head', 'template', 'svg', 'math', 'noscript', 'ac:parameter',
]);

export function isConfluenceStorage(content: string): boolean {
  return DOCUMENT_TAG.test(content);
}

function safeReference(value: string, sourceUrl?: string | null): string | undefined {
  if (isSafeHttpUrl(value)) return value.trim();
  if (!value.trim() || !sourceUrl || !isSafeHttpUrl(sourceUrl)) return undefined;
  try {
    const url = new URL(value, sourceUrl).href;
    return isSafeHttpUrl(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

function attachmentName(element: Element): string | undefined {
  return Array.from(element.getElementsByTagName('ri:attachment'))
    .map(attachment => attachment.getAttribute('ri:filename')?.trim())
    .find(Boolean);
}

function renderStorage(content: string, sourceUrl?: string | null): ReactNode {
  // Keep external resources inert while parsing and rebuild only readable elements.
  const template = document.createElement('template');
  template.innerHTML = content
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_match, text: string) =>
      text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    )
    .replace(/<((?:ac|ri):[a-z-]+)(?=[\s/])((?:"[^"]*"|'[^']*'|[^'"<>])*?)\/>/gi, '<$1$2></$1>');

  const children = (node: Node, elementsOnly = false) =>
    Array.from(elementsOnly ? (node as Element).children : node.childNodes, render);

  function render(node: Node, key: number): ReactNode {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      return /https?:\/\//i.test(text) && !node.parentElement?.closest('a, code')
        ? <LinkifiedText key={key} text={text} /> : text;
    }
    if (!(node instanceof Element)) return null;
    const tag = node.localName.toLowerCase();
    if (OMITTED_TAGS.has(tag)) return null;
    if (tag === 'pre' || (tag === 'ac:structured-macro' && /^(?:code|noformat)$/.test(node.getAttribute('ac:name') || ''))) {
      const body = node.getElementsByTagName('ac:plain-text-body')[0] ?? node;
      return <pre key={key} className="tf-md-code-block"><code>{body.textContent}</code></pre>;
    }
    if (tag === 'img' || tag === 'ac:image' || tag === 'ri:attachment') {
      const name = tag === 'ri:attachment' ? node.getAttribute('ri:filename') : attachmentName(node) || node.getAttribute('alt');
      return <span key={key} className="tf-confluence-reference">{name ? '附件：' + name : '文档图片（见原文）'}</span>;
    }
    if (tag === 'a' || tag === 'ac:link') {
      const target = node.getElementsByTagName('ri:url')[0]?.getAttribute('ri:value');
      const href = safeReference(node.getAttribute('href') || target || '', sourceUrl);
      const label = node.getElementsByTagName('ac:plain-text-link-body')[0]?.textContent ||
        node.getElementsByTagName('ac:link-body')[0]?.textContent ||
        node.textContent?.trim() ||
        node.getElementsByTagName('ri:page')[0]?.getAttribute('ri:content-title') ||
        attachmentName(node) || target;
      const body = tag === 'a' && node.textContent?.trim() ? children(node) : label || href;
      return href
        ? <a key={key} className="tf-content-link" href={href} target="_blank" rel="noopener noreferrer">{body}</a>
        : <Fragment key={key}>{body}</Fragment>;
    }
    if (/^h[1-6]$/.test(tag)) {
      const level = Math.min(Number(tag[1]) + 2, 6);
      return createElement('h' + level, { key, className: 'tf-confluence-heading' }, children(node));
    }
    if (tag === 'table') {
      return <div key={key} className="tf-md-table-wrap"><table className="tf-md-table">{children(node, true)}</table></div>;
    }
    if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot' || tag === 'tr') {
      return createElement(tag, { key }, children(node, true));
    }
    if (tag === 'th' || tag === 'td') {
      return createElement(tag, {
        key,
        colSpan: (node as HTMLTableCellElement).colSpan,
        rowSpan: (node as HTMLTableCellElement).rowSpan,
      }, children(node));
    }
    if (tag === 'br' || tag === 'hr') return createElement(tag, { key });
    if (CONTENT_TAGS.has(tag)) return createElement(tag, { key }, children(node));
    return <Fragment key={key}>{children(node)}</Fragment>;
  }

  return children(template.content);
}

export function ConfluencePreview({ content, sourceUrl }: { content: string; sourceUrl?: string | null }) {
  const body = useMemo(() => renderStorage(content, sourceUrl), [content, sourceUrl]);
  return <div className="tf-md-preview tf-confluence-preview" aria-label="Confluence 正文">{body}</div>;
}
