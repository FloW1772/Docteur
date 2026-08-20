import { assertSafeUrl } from './url-security.js';

const COMMON_SUBDOMAINS = new Set(['www', 'm', 'mobile', 'amp', 'blog', 'news', 'info']);

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

function stripTags(value) {
  return decodeHtmlEntities(String(value ?? '').replace(/<[^>]+>/g, ' '));
}

function firstNonEmptyLine(value) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .find((line) => line.length > 0) ?? '';
}

function splitTitleOnSeparator(title) {
  const match = cleanText(title).match(/^(.+?)\s*[-|:]\s*(.+)$/u);
  if (!match) return null;
  return {
    parent: cleanText(match[1]),
    child: cleanText(match[2]),
  };
}

function capitalizeWord(word) {
  const text = cleanText(word);
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function splitDomainLabel(label) {
  const text = cleanText(label);
  if (!text) return [];

  const lower = text.toLowerCase();
  for (const prefix of ['le', 'la', 'les', 'the', 'de', 'du', 'des']) {
    if (lower.startsWith(prefix) && lower.length > prefix.length + 2) {
      return [text.slice(0, prefix.length), text.slice(prefix.length)];
    }
  }

  return text.split(/(?=[A-Z])/g).filter(Boolean);
}

function formatDomainName(hostname) {
  const host = cleanText(hostname).replace(/^www\./i, '');
  if (!host) return 'Source';

  const labels = host.split('.').filter(Boolean);
  if (labels.length === 0) return 'Source';

  const withoutTld = labels.length > 1 ? labels.slice(0, -1) : labels;
  const candidate = withoutTld.filter((label, index) => {
    if (index === withoutTld.length - 1) return true;
    return !COMMON_SUBDOMAINS.has(label.toLowerCase());
  }).pop() ?? withoutTld.at(-1) ?? labels[0];

  return splitDomainLabel(candidate)
    .map((part) => part.replace(/[-_.]+/g, ' '))
    .flatMap((part) => part.split(/\s+/))
    .filter(Boolean)
    .map(capitalizeWord)
    .join(' ')
    .trim() || 'Source';
}

function parseMetaTags(html) {
  const tags = String(html ?? '').match(/<meta\b[^>]*>/gi) ?? [];
  return tags.map((tag) => {
    const attrs = {};
    tag.replace(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g, (_, key, _raw, doubleQuoted, singleQuoted, bare) => {
      attrs[key.toLowerCase()] = doubleQuoted ?? singleQuoted ?? bare ?? '';
      return '';
    });
    return attrs;
  });
}

function metaContent(tags, names, attribute = 'property') {
  const lookup = new Set(names.map((name) => name.toLowerCase()));
  for (const tag of tags) {
    const key = String(tag?.[attribute] ?? tag?.name ?? '').toLowerCase();
    if (lookup.has(key) && tag.content) {
      return cleanText(tag.content);
    }
  }
  return '';
}

function extractTitleFromHtml(html) {
  const metaTags = parseMetaTags(html);
  const ogTitle = metaContent(metaTags, ['og:title'], 'property');
  if (ogTitle) return ogTitle;

  const titleMatch = String(html ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    return cleanText(stripTags(titleMatch[1]));
  }

  return '';
}

function extractMetaContentFromHtml(html, names) {
  const metaTags = parseMetaTags(html);
  return metaContent(metaTags, names, 'property') || metaContent(metaTags, names, 'name');
}

async function fetchText(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Docteur/1.0 (+https://localhost)',
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = 8000) {
  const text = await fetchText(url, timeoutMs);
  return JSON.parse(text);
}

function makeNeuron(title, kind, content, metadata = {}) {
  return {
    title: cleanText(title),
    kind,
    content: String(content ?? '').trim(),
    metadata,
  };
}

function makeCaptureMetadata(base) {
  return {
    capture: {
      ...base,
    },
  };
}

function makeChild(title, kind, content, capture) {
  return makeNeuron(title, kind, content, makeCaptureMetadata(capture));
}

function makeParent(title, content, capture) {
  return makeNeuron(title, 'channel', content, makeCaptureMetadata(capture));
}

async function captureYouTube(url) {
  try {
    const oembed = await fetchJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    const videoTitle = cleanText(oembed?.title ?? '');
    const authorName = cleanText(oembed?.author_name ?? '');
    const parsed = splitTitleOnSeparator(videoTitle);

    if (parsed) {
      return {
        parent: makeParent(parsed.parent, authorName || parsed.parent, {
          sourceType: 'youtube',
          sourceUrl: url,
          sourceName: authorName || parsed.parent,
          parentStrategy: 'title_separator',
          status: 'ok',
        }),
        child: makeChild(parsed.child, 'note', `${videoTitle}\n\n${url}`, {
          sourceType: 'youtube',
          sourceUrl: url,
          sourceName: authorName,
          parentTitle: parsed.parent,
          sourceTitle: videoTitle,
          status: 'ok',
        }),
      };
    }

    if (normalize(authorName) === normalize('FloW')) {
      return {
        parent: null,
        child: makeChild(videoTitle || 'Vidéo YouTube', 'note', `${videoTitle || url}\n\n${url}`, {
          sourceType: 'youtube',
          sourceUrl: url,
          sourceName: authorName,
          parentStrategy: 'none',
          status: 'ok',
        }),
      };
    }

    if (authorName) {
      return {
        parent: makeParent(authorName, authorName, {
          sourceType: 'youtube',
          sourceUrl: url,
          sourceName: authorName,
          parentStrategy: 'author_name',
          status: 'ok',
        }),
        child: makeChild(videoTitle || 'Vidéo YouTube', 'note', `${videoTitle || url}\n\n${url}`, {
          sourceType: 'youtube',
          sourceUrl: url,
          sourceName: authorName,
          sourceTitle: videoTitle,
          parentTitle: authorName,
          status: 'ok',
        }),
      };
    }

    return {
      parent: null,
      child: makeChild(videoTitle || 'Vidéo YouTube', 'note', `${videoTitle || url}\n\n${url}`, {
        sourceType: 'youtube',
        sourceUrl: url,
        parentStrategy: 'unresolved',
        status: 'limited',
        warning: 'parent_not_identified',
      }),
    };
  } catch (error) {
    return {
      parent: null,
      child: makeChild('Vidéo YouTube', 'note', url, {
        sourceType: 'youtube',
        sourceUrl: url,
        parentStrategy: 'failed',
        status: 'limited',
        warning: 'parent_not_identified',
        error: String(error?.message ?? error),
      }),
    };
  }
}

async function captureGitHub(url) {
  const parsed = new URL(url);
  const [owner, repo] = parsed.pathname.split('/').filter(Boolean);
  const ownerTitle = capitalizeWord(owner);
  let description = '';

  try {
    const repoData = await fetchJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    description = cleanText(repoData?.description ?? '');
  } catch {
    description = '';
  }

  return {
    parent: makeParent(ownerTitle, ownerTitle, {
      sourceType: 'github',
      sourceUrl: url,
      sourceName: owner,
      parentStrategy: 'owner',
      status: 'ok',
    }),
    child: makeChild(repo || 'repository', 'reference', description || repo || url, {
      sourceType: 'github',
      sourceUrl: url,
      sourceName: owner,
      repoName: repo,
      description,
      status: 'ok',
    }),
  };
}

async function captureTwitter(url) {
  const parsed = new URL(url);
  const username = parsed.pathname.split('/').filter(Boolean)[0] ?? '';

  try {
    const oembed = await fetchJson(`https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=1`);
    const html = String(oembed?.html ?? '');
    const blockquote = html.match(/<blockquote[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    const text = blockquote?.[1] ? cleanText(stripTags(blockquote[1])) : '';

    return {
      parent: makeParent(`@${username}`, `@${username}`, {
        sourceType: 'twitter',
        sourceUrl: url,
        sourceName: username,
        parentStrategy: 'username',
        status: 'ok',
      }),
      child: makeChild(text || `@${username}`, 'note', text || url, {
        sourceType: 'twitter',
        sourceUrl: url,
        sourceName: username,
        tweetText: text,
        status: 'ok',
      }),
    };
  } catch {
    try {
      const html = await fetchText(url);
      const title = extractTitleFromHtml(html);
      const quoted = title.match(/^(.*?)\s+on\s+(?:X|Twitter):\s+"([\s\S]+)"$/i);
      const text = quoted?.[2] ? cleanText(quoted[2]) : cleanText(title);

      return {
        parent: makeParent(`@${username}`, `@${username}`, {
          sourceType: 'twitter',
          sourceUrl: url,
          sourceName: username,
          parentStrategy: 'username',
          status: 'limited',
          warning: 'tweet_extraction_fallback',
        }),
        child: makeChild(text || `@${username}`, 'note', text || url, {
          sourceType: 'twitter',
          sourceUrl: url,
          sourceName: username,
          tweetText: text,
          status: 'limited',
        }),
      };
    } catch (error) {
      return {
        parent: makeParent(`@${username}`, `@${username}`, {
          sourceType: 'twitter',
          sourceUrl: url,
          sourceName: username,
          parentStrategy: 'failed',
          status: 'limited',
          warning: 'parent_not_identified',
          error: String(error?.message ?? error),
        }),
        child: makeChild(`@${username}`, 'note', url, {
          sourceType: 'twitter',
          sourceUrl: url,
          sourceName: username,
          status: 'limited',
          warning: 'parent_not_identified',
          error: String(error?.message ?? error),
        }),
      };
    }
  }
}

async function captureReddit(url) {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter(Boolean);
  const subreddit = segments[1] ?? segments[0] ?? '';

  try {
    const html = await fetchText(url);
    const rawTitle = extractTitleFromHtml(html) || extractMetaContentFromHtml(html, ['title']) || `r/${subreddit}`;
    const title = cleanText(
      rawTitle
        .replace(/\s*[:\-]\s*r\/[^\s]+$/i, '')
        .replace(/\s*[:\-]\s*Reddit$/i, '')
    ) || `r/${subreddit}`;

    return {
      parent: makeParent(`r/${subreddit}`, `r/${subreddit}`, {
        sourceType: 'reddit',
        sourceUrl: url,
        sourceName: subreddit,
        parentStrategy: 'subreddit',
        status: 'ok',
      }),
      child: makeChild(title, 'note', `${title}\n\n${url}`, {
        sourceType: 'reddit',
        sourceUrl: url,
        sourceName: subreddit,
        postTitle: title,
        status: 'ok',
      }),
    };
  } catch (error) {
    return {
      parent: makeParent(`r/${subreddit}`, `r/${subreddit}`, {
        sourceType: 'reddit',
        sourceUrl: url,
        sourceName: subreddit,
        parentStrategy: 'subreddit',
        status: 'limited',
        warning: 'parent_not_identified',
        error: String(error?.message ?? error),
      }),
      child: makeChild(`r/${subreddit}`, 'note', url, {
        sourceType: 'reddit',
        sourceUrl: url,
        sourceName: subreddit,
        status: 'limited',
        warning: 'parent_not_identified',
        error: String(error?.message ?? error),
      }),
    };
  }
}

async function captureArticle(url) {
  try {
    const html = await fetchText(url);
    const metaTags = parseMetaTags(html);
    const siteName = metaContent(metaTags, ['og:site_name'], 'property') || metaContent(metaTags, ['application-name'], 'name');
    const articleTitle = extractTitleFromHtml(html) || extractMetaContentFromHtml(html, ['og:title', 'title']) || new URL(url).hostname;
    const parentTitle = siteName || formatDomainName(new URL(url).hostname);

    return {
      parent: makeParent(parentTitle, parentTitle, {
        sourceType: 'web',
        sourceUrl: url,
        sourceName: parentTitle,
        parentStrategy: siteName ? 'og:site_name' : 'domain',
        status: 'ok',
      }),
      child: makeChild(articleTitle, 'reference', `${articleTitle}\n\n${url}`, {
        sourceType: 'web',
        sourceUrl: url,
        sourceName: parentTitle,
        articleTitle,
        status: 'ok',
      }),
    };
  } catch (error) {
    const hostname = (() => {
      try { return new URL(url).hostname; } catch { return 'Source'; }
    })();
    const parentTitle = formatDomainName(hostname);
    return {
      parent: makeParent(parentTitle, parentTitle, {
        sourceType: 'web',
        sourceUrl: url,
        sourceName: parentTitle,
        parentStrategy: 'domain',
        status: 'limited',
        warning: 'parent_not_identified',
        error: String(error?.message ?? error),
      }),
      child: makeChild(parentTitle, 'reference', url, {
        sourceType: 'web',
        sourceUrl: url,
        sourceName: parentTitle,
        status: 'limited',
        warning: 'parent_not_identified',
        error: String(error?.message ?? error),
      }),
    };
  }
}

async function captureText(input, generateNoteTitle) {
  const text = cleanText(input);
  let headline = '';
  if (typeof generateNoteTitle === 'function') {
    try {
      headline = cleanText(await generateNoteTitle(text));
    } catch {
      headline = '';
    }
  }

  if (!headline) {
    const line = firstNonEmptyLine(text) || text;
    headline = line.replace(/[.!?…]+$/u, '').slice(0, 96).trim();
  }

  headline = headline || 'Nouvelle note';

  return {
    parent: null,
    child: makeChild(headline, 'note', text, {
      sourceType: 'text',
      status: 'ok',
      parentStrategy: 'none',
    }),
  };
}

export async function buildCaptureResult(input, options = {}) {
  const raw = cleanText(input);
  if (!raw) {
    throw new Error('Payload invalide. Champ requis: input.');
  }

  if (!/^https?:\/\//i.test(raw)) {
    return captureText(raw, options.generateNoteTitle);
  }

  // SSRF guard — rejects internal addresses before any outbound request
  assertSafeUrl(raw);

  const url = new URL(raw);
  const host = url.hostname.toLowerCase();

  if (host.includes('youtube.com') || host === 'youtu.be') {
    return captureYouTube(raw);
  }
  if (host === 'github.com' || host.endsWith('.github.com')) {
    return captureGitHub(raw);
  }
  if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) {
    return captureTwitter(raw);
  }
  if (host === 'reddit.com' || host.endsWith('.reddit.com') || host === 'www.reddit.com') {
    return captureReddit(raw);
  }

  return captureArticle(raw);
}
