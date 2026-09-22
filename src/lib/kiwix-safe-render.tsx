import { createElement, type ReactNode } from 'react';

/**
 * Safe rendering path for ZIM article HTML, replacing dangerouslySetInnerHTML.
 *
 * The server (cortex-server/src/lib/kiwix-sanitize.js) already strips
 * <script>/<style>/<link>/<noscript>/<iframe> and on* attributes before this
 * HTML ever reaches the frontend — but the mission is categorical: ZIM
 * content (often Wikipedia-derived, from an offline archive Docteur did not
 * author) must never be injected as raw HTML in V1, full stop, regardless of
 * how tight the server-side sanitization already is. This module parses the
 * (already-cleaned) HTML with DOMParser into a detached document — never
 * attached to the live page, so no attached-DOM script/style ever executes —
 * then walks it into a plain React element tree, re-applying its own
 * independent allowlist (defense in depth: this does not trust the server's
 * allowlist is the only thing standing between the archive and the DOM).
 *
 * Anything outside the allowlist (including <script>, <style>, event
 * handler attributes, javascript:/data: URLs) is dropped or defanged here,
 * a second time, client-side.
 */

const ALLOWED_TAGS = new Set([
  'a', 'p', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead',
  'tbody', 'tr', 'td', 'th', 'img', 'blockquote', 'code', 'pre', 'sup',
  'sub', 'small', 'figure', 'figcaption', 'caption', 'dl', 'dt', 'dd',
]);

const VOID_TAGS = new Set(['br', 'hr', 'img']);

function isSafeHref(value: string): boolean {
  const v = value.trim();
  // Internal zim:// links (rewritten server-side) and in-page anchors are
  // safe. http(s)/mailto external links are safe (rendered with
  // target=_blank + rel=noopener). Everything else — javascript:, data:,
  // vbscript:, file:, bare relative paths that escaped sanitization — is
  // rejected.
  if (v.startsWith('zim://')) return true;
  if (v.startsWith('#')) return true;
  if (/^https?:\/\//i.test(v)) return true;
  if (/^mailto:/i.test(v)) return true;
  return false;
}

function isSafeImgSrc(value: string): boolean {
  // Images are rewritten server-side to /api/kiwix/raw/... — only accept
  // that proxy path (relative, same-origin) or a rare inline data: image
  // the server chose not to rewrite; reject everything else (http(s) direct
  // to an external host, javascript:, etc.).
  const v = value.trim();
  return v.startsWith('/api/kiwix/raw/') || /^data:image\//i.test(v);
}

let keyCounter = 0;

function renderNode(node: ChildNode): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) {
    // Unknown/disallowed tag: render its text content only (never its
    // markup), so structure the sanitizer didn't anticipate degrades to
    // plain text instead of being silently dropped or, worse, trusted.
    return el.textContent ?? '';
  }

  const key = `k${keyCounter++}`;
  const props: Record<string, unknown> = { key };

  if (tag === 'a') {
    const href = el.getAttribute('href') ?? '';
    const zimLink = el.getAttribute('data-zim-link');
    if (zimLink) props['data-zim-link'] = zimLink;
    if (isSafeHref(href)) {
      props.href = href;
      if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
        props.target = '_blank';
        props.rel = 'noopener noreferrer';
      }
    }
    // else: render as a plain, non-navigable span-like anchor (no href)
  } else if (tag === 'img') {
    const src = el.getAttribute('src') ?? '';
    if (isSafeImgSrc(src)) {
      props.src = src;
      props.alt = el.getAttribute('alt') ?? '';
      props.loading = 'lazy';
      props.style = { maxWidth: '100%' };
    } else {
      return null; // drop unsafe images entirely rather than render a broken/unsafe src
    }
  }

  if (VOID_TAGS.has(tag)) {
    return createElement(tag, props);
  }

  const children = Array.from(el.childNodes).map(renderNode);
  return createElement(tag, props, ...children);
}

/**
 * Parses already-server-sanitized ZIM article HTML and returns a safe React
 * element tree — no dangerouslySetInnerHTML anywhere in this path.
 */
export function renderSafeZimHtml(html: string): ReactNode {
  keyCounter = 0;
  let doc: Document;
  try {
    // DOMParser produces a detached Document — never attached to the live
    // page — so nothing in it executes, regardless of content.
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return null;
  }
  // Defense in depth: even though this is a detached document, strip any
  // script/style elements outright before walking (belt-and-suspenders on
  // top of the tag allowlist above, which already excludes them).
  doc.querySelectorAll('script, style').forEach((n) => n.remove());
  const body = doc.body;
  if (!body) return null;
  return Array.from(body.childNodes).map(renderNode);
}
