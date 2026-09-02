import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Search, Plus, RefreshCw, Bookmark, BookmarkCheck, Globe, BookOpen, Mountain, CheckCircle, AlertTriangle } from 'lucide-react';
import { MarkdownContent } from '../../lib/renderMd';
import { generateId } from '../../lib/generateId';
import { cortexClient } from '../../lib/cortex/client';
import type { SearchHit, AnswerResult, ClarifyQuestion, ResearchQuota, DeepResearchOptions, WebAnswerSource, WebSearchResult, WebDeepSource, WebDeepEvent } from '../../lib/cortex/client';
import type { Page, PageKind } from '../../lib/types';
import { KIND_META } from '../../lib/types';
import { getCorpusTrustedSites } from '../../lib/corpusSettings';

const RESEARCH_RE          = /^(?:veille|recherche)\s+(.+)$/iu;
const MULTI_SOURCE_RE      = /^veille\+\+\s+(.+)$/iu;
const DEEP_RESEARCH_RE     = /^(?:veille\+|veille\s+approfondie)\s+(.+)$/iu;
const LOCAL_RE     = /^(?:local|privé|prive|puissant|powerful)\s+(.+)$/iu;
const LIS_RE       = /^lis\s+(.+)$/iu;
const OUVRE_RE     = /^ouvre\s+(.+)$/iu;
const PDF_RE       = /^pdf\s+(.+)$/iu;
const COMPARE_RE   = /^comparer?\s+(.+)$/iu;
const WEB_RE       = /^web\s+(.+)$/iu;
const CHERCHE_RE   = /^cherche\s+(.+)$/iu;
const CORPUS_RE    = /^corpus\s+(.+)$/iu;
const CORPUS_MAX_SELECT = 20;

// ── Default site shortcuts ────────────────────────────────────────────────────

const DEFAULT_SHORTCUTS: Record<string, string> = {
  youtube:   'https://www.youtube.com',
  google:    'https://www.google.com',
  wikipedia: 'https://fr.wikipedia.org',
  github:    'https://github.com',
  gmail:     'https://mail.google.com',
  maps:      'https://www.openstreetmap.org',
  gmaps:     'https://maps.google.com',
  drive:     'https://drive.google.com',
  twitch:    'https://www.twitch.tv',
  reddit:    'https://www.reddit.com',
  leboncoin: 'https://www.leboncoin.fr',
  amazon:    'https://www.amazon.fr',
  lemonde:   'https://www.lemonde.fr',
  chatgpt:   'https://chatgpt.com',
  claude:    'https://claude.ai',
  twitter:   'https://x.com',
  x:         'https://x.com',
  instagram: 'https://www.instagram.com',
  linkedin:  'https://www.linkedin.com',
};

function normalizeShortcutName(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// Simple Levenshtein distance — used only to suggest "did you mean X?" for an
// unrecognized shortcut name (typo, or voice mis-transcription of a known one).
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Returns the closest known shortcut name if it's a plausible typo/mis-hearing
// of `name` (distance <= 2, or <= 1 for very short names), else null.
function closestShortcutName(name: string, allShortcuts: Record<string, string>): string | null {
  const target = normalizeShortcutName(name);
  let best: string | null = null;
  let bestDist = Infinity;
  for (const key of Object.keys(allShortcuts)) {
    const d = levenshtein(target, key);
    if (d < bestDist) { bestDist = d; best = key; }
  }
  const threshold = target.length <= 4 ? 1 : 2;
  return best && bestDist <= threshold && bestDist > 0 ? best : null;
}

// ── Clarification types ───────────────────────────────────────────────────────

interface ClarifyAnswer {
  question:  string;
  answer:    string;
  isDefault: boolean;  // "decide for me"
}

interface ClarificationState {
  query:      string;
  forceLocal: boolean;
  questions:  ClarifyQuestion[];
  currentIdx: number;
  answers:    ClarifyAnswer[];
}

// Cheap client-side pre-filter: returns true if clarification is definitely
// NOT needed (factual question, neuron query, command). Avoids a cloud call.
function isDefinitelyDirect(q: string): boolean {
  const lower = q.toLowerCase().trim();
  // Commands already handled upstream, but guard here too
  if (/^veille\+\+\s/i.test(lower)) return true;
  if (/^(?:veille\+|veille\s+approfondie)\s/i.test(lower)) return true;
  if (/^(?:veille|recherche|lis|ouvre|local|privé|prive|puissant|pdf|web|cherche)\s/i.test(lower)) return true;
  // Factual openers
  if (/^(?:qu['']est[-\s]ce que|c['']est quoi|définition|definition|quand\s|qui est|combien coûte|quel est le|quelle est la|comment fonctionne|explain |what is |how does )/i.test(lower)) return true;
  // Questions about own neurons/notes
  if (/(?:mes neurones|mes notes|mes articles|mes vidéos|mes videos|mon cortex|résume\s+mes|resume\s+mes|dans\s+mes\s+notes|j['']ai\s+noté|j['']ai\s+note)/i.test(lower)) return true;
  return false;
}

// ── Command helpers ───────────────────────────────────────────────────────────

const _URL_RE = /https?:\/\/[\w\-.~:/?#[\]@!$&'()*+,;=%]+/g;

function _stripTrail(url: string): string { return url.replace(/[.,;:!?)>\]'"]+$/, ''); }

function _getYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0] || null;
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
    return null;
  } catch { return null; }
}

function extractFirstYouTubeId(page: Page): string | null {
  for (const block of page.blocks ?? []) {
    _URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = _URL_RE.exec(block.content ?? '')) !== null) {
      const id = _getYouTubeId(_stripTrail(m[0]));
      if (id) return id;
    }
  }
  return null;
}

function getPageSourceUrl(page: Page): string | null {
  const url = page.metadata?.url ?? page.metadata?.sourceUrl;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

function looksLikeUrl(s: string): boolean {
  if (/^https?:\/\//i.test(s)) return true;
  return /^[a-zA-Z0-9][\w-]*\.[a-z]{2,}(\/|$)/i.test(s);
}

function ensureHttps(s: string): string {
  return /^https?:\/\//i.test(s) ? s : 'https://' + s;
}

// ─────────────────────────────────────────────────────────────────────────────

type Mode = 'search' | 'question';

type VideoHit = { page: Page; videoId: string };
type OuvreHit = { page: Page; sourceUrl: string };
type CommandState =
  | { type: 'lis';   keywords: string; results: VideoHit[] }
  | { type: 'ouvre'; arg: string; url: string | null; hits: OuvreHit[]; suggestion?: string; suggestionUrl?: string }
  | null;

interface WebAnswerState {
  phase:        'searching' | 'fetching' | 'answering' | 'done' | 'error';
  phaseMessage?: string;
  answer?:      string;
  sources?:     WebAnswerSource[];
  modelUsed?:   string | null;
  latencyMs?:   number;
}

type ExplorePhase = 'choosing' | 'a-running' | 'b-running' | 'b-done' | 'b-cancelled' | 'error';

interface ExploreState {
  phase:         ExplorePhase;
  pages:         WebDeepSource[];
  pageIndex:     number;
  pageTotal:     number;
  msg:           string;
  modeAResults?: WebSearchResult[];
  result?:       { content: string; sources: WebDeepSource[]; modelUsed?: string; latencyMs?: number; cancelled: boolean };
  error?:        string;
}

interface CorpusSearchState {
  subject:  string;
  phase:    'loading' | 'results' | 'error' | 'capturing' | 'done';
  results:  WebSearchResult[];
  selected: Set<string>; // urls
  error?:   string;
  progress?: { done: number; total: number };
  summary?: { ok: number; total: number; failures: Array<{ name: string; error: string }> };
}

interface ChatEntry {
  id:                     string;
  query:                  string;
  answer?:                AnswerResult;
  error?:                 string;
  forceLocal?:            boolean;
  clarificationContext?:  ClarifyAnswer[];
  webAnswer?:             WebAnswerState;
}

interface Props {
  isOpen:             boolean;
  onClose:            () => void;
  onNavigate:         (pageId: string) => void;
  onCreatePage:       () => void;
  onHighlightSources: (ids: string[]) => void;
  onClearHighlights:  () => void;
  onSaveQR:           (question: string, answer: AnswerResult, clarificationContext?: ClarifyAnswer[]) => Promise<void>;
  onAnalyzeImage?:    (imageId: string) => void;
  onOpenConversation?: () => void;
  onResearch:             (subject: string, mode: 'synthese' | 'actualite') => Promise<void>;
  onDeepResearch:         (subject: string, options: DeepResearchOptions) => Promise<void>;
  onMultiSourceResearch:  (subject: string, angles: number) => Promise<void>;
  onPlayVideo:        (videoId: string, title: string) => void;
  onPdfSubject?:      (subject: string) => void;
  onCompare?:               (question: string) => void;
  onSaveWebAnswer?:         (query: string, answer: string, sources: WebAnswerSource[]) => Promise<void>;
  onCreateWebResultsNeuron?: (subject: string, results: WebSearchResult[]) => Promise<void>;
  onCreateWebDeepNeuron?:    (subject: string, content: string, sources: WebDeepSource[], cancelled: boolean) => Promise<void>;
  customShortcuts?:          Record<string, string>;
  pages:              Page[];
  isOnline?:          boolean | null;
  initialQuery?:      string | null;
}

function localTextSearch(query: string, pages: Page[]): SearchHit[] {
  const q = query.toLowerCase().trim();
  if (q.length < 2) return [];
  return pages
    .filter(p => {
      if (p.title.toLowerCase().includes(q)) return true;
      return p.blocks?.some(b => b.content?.toLowerCase().includes(q));
    })
    .slice(0, 12)
    .map(p => {
      const matchBlock = p.blocks?.find(b => b.content?.toLowerCase().includes(q));
      return {
        id:              p.id,
        title:           p.title,
        kind:            p.kind,
        score:           1,
        content_preview: matchBlock?.content?.slice(0, 120),
      };
    });
}

function hexRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}

export default function SearchConsole({
  isOpen, onClose, onNavigate, onCreatePage, onHighlightSources, onClearHighlights, onSaveQR, onResearch, onDeepResearch, onMultiSourceResearch, onPlayVideo, onPdfSubject, onCompare, onSaveWebAnswer, onCreateWebResultsNeuron, onCreateWebDeepNeuron, onAnalyzeImage, onOpenConversation, customShortcuts, pages, isOnline, initialQuery,
}: Props) {
  const [imagePasting, setImagePasting] = useState(false);

  async function handleImagePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    if (!onAnalyzeImage) return;
    const items   = Array.from(e.clipboardData.items);
    const imgItem = items.find(it => it.kind === 'file' && it.type.startsWith('image/'));
    if (!imgItem) return;
    e.preventDefault();
    const file = imgItem.getAsFile();
    if (!file) return;
    setImagePasting(true);
    try {
      const { id } = await cortexClient.uploadImage(file);
      onAnalyzeImage(id);
    } catch { /* upload failed — silently skip, no image to analyze */ }
    finally { setImagePasting(false); }
  }

  const offline = isOnline === false;
  const [mode, setMode]                   = useState<Mode>('search');
  const [query, setQuery]                 = useState('');
  const [isLoading, setIsLoading]         = useState(false);
  const [searchResults, setSearchResults] = useState<SearchHit[] | null>(null);
  const [chatHistory, setChatHistory]     = useState<ChatEntry[]>([]);
  const [typingAnswer, setTypingAnswer]   = useState('');
  const [filterKinds, setFilterKinds]     = useState<Set<PageKind>>(new Set());
  const [serverDown, setServerDown]       = useState(false);
  const [queryHistory, setQueryHistory]   = useState<string[]>([]);
  const [historyIdx, setHistoryIdx]       = useState(-1);
  const [savedEntries, setSavedEntries]       = useState<Set<string>>(new Set());
  const [savingEntry, setSavingEntry]         = useState<string | null>(null);
  const [corpusSearch, setCorpusSearch]                     = useState<CorpusSearchState | null>(null);
  const corpusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [researchSubject, setResearchSubject]               = useState<string | null>(null);
  const [researchLoading, setResearchLoading]               = useState(false);
  const [deepResearchSubject, setDeepResearchSubject]       = useState<string | null>(null);
  const [multiSourceSubject, setMultiSourceSubject]         = useState<string | null>(null);
  const [localMode, setLocalMode]             = useState(false);
  const [answerScope, setAnswerScope]         = useState<'all' | 'personal' | 'reference'>('all');
  const [commandState, setCommandState]       = useState<CommandState>(null);
  const [exploreSubject, setExploreSubject]   = useState<string | null>(null);
  const [exploreState, setExploreState]       = useState<ExploreState | null>(null);
  const exploreCancelTokenRef                 = useRef<string>('');
  const exploreAbortRef                       = useRef<AbortController | null>(null);
  const [clarifyLoading, setClarifyLoading]   = useState(false);
  const [clarification, setClarification]     = useState<ClarificationState | null>(null);

  const inputRef           = useRef<HTMLInputElement>(null);
  const chatBottomRef      = useRef<HTMLDivElement>(null);
  const typingIntervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const highlightTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Holds the latest handleQuestion — lets the open/close effect (declared before
  // handleQuestion) trigger it for voice-originated queries without a TDZ issue.
  const handleQuestionRef  = useRef<(overrideQuery?: string) => void>(() => {});

  // ── Focus & reset on open/close ──────────────────────────────────────────

  useEffect(() => {
    if (isOpen) {
      if (initialQuery) {
        setQuery(initialQuery);
        // "ouvre X" via voice must trigger the exact same shortcut/neuron-open behavior
        // as typing it — auto-run it through the normal handler. Other voice-originated
        // queries (questions, research, etc.) still just prefill for the user to confirm.
        if (OUVRE_RE.test(initialQuery.trim())) {
          handleQuestionRef.current(initialQuery);
        }
      }
      requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
    } else {
      setQuery('');
      setSearchResults(null);
      setCommandState(null);
      setClarification(null);
      stopTyping();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  function stopTyping() {
    if (typingIntervalRef.current) { clearInterval(typingIntervalRef.current); typingIntervalRef.current = null; }
    if (highlightTimerRef.current) { clearTimeout(highlightTimerRef.current); highlightTimerRef.current = null; }
  }

  // ── Keyboard shortcuts inside modal ──────────────────────────────────────

  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { onClose(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        switchMode(mode === 'search' ? 'question' : 'search');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, mode]);

  function switchMode(m: Mode) {
    setMode(m);
    setQuery('');
    setSearchResults(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // ── Search debounce (mode RECHERCHE) ─────────────────────────────────────

  useEffect(() => {
    if (mode !== 'search') return;
    const q = query.trim();
    if (q.length < 2) { setSearchResults(null); return; }

    if (offline) {
      // Local text search — no server needed
      const kinds = filterKinds.size > 0 ? filterKinds : null;
      const hits  = localTextSearch(q, pages)
        .filter(h => !kinds || kinds.has(h.kind as import('../../lib/types').PageKind));
      setSearchResults(hits);
      return;
    }

    const timer = setTimeout(async () => {
      setIsLoading(true);
      setServerDown(false);
      try {
        const kinds = filterKinds.size > 0 ? [...filterKinds] : undefined;
        const res   = await cortexClient.search(q, { limit: 8, threshold: 0.2, filter_by_kind: kinds });
        setSearchResults(res.results);
      } catch {
        setServerDown(true);
        setSearchResults(null);
      } finally {
        setIsLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, mode, filterKinds, offline, pages]);

  // ── Core answer submission (used for direct and post-clarification) ──────────

  const submitDirectAnswer = useCallback(async (
    q:         string,
    forceLocal: boolean,
    clarificationAnswers: ClarifyAnswer[],
  ) => {
    stopTyping();
    setQueryHistory(prev => [q, ...prev.filter(h => h !== q)].slice(0, 20));
    setHistoryIdx(-1);
    setIsLoading(true);
    setServerDown(false);

    const entryId  = generateId();
    const newEntry: ChatEntry = { id: entryId, query: q, forceLocal, clarificationContext: clarificationAnswers };
    setChatHistory(prev => [...prev, newEntry]);

    const clarCtx = clarificationAnswers.map(a => ({ question: a.question, answer: a.answer }));

    try {
      const result = await cortexClient.answer(q, {
        max_context: 5,
        scope: answerScope,
        ...(forceLocal ? { force_local_powerful: true } : {}),
        ...(clarCtx.length > 0 ? { clarification_context: clarCtx } : {}),
      });

      setChatHistory(prev => prev.map(e => e.id === entryId ? { ...e, answer: result } : e));

      const sourceIds = result.sources.map(s => s.id).filter(Boolean);
      if (sourceIds.length > 0) {
        onHighlightSources(sourceIds);
        highlightTimerRef.current = setTimeout(onClearHighlights, 4000);
      }

      let i = 0;
      setTypingAnswer('');
      typingIntervalRef.current = setInterval(() => {
        i++;
        setTypingAnswer(result.answer.slice(0, i));
        if (i >= result.answer.length) {
          clearInterval(typingIntervalRef.current!);
          typingIntervalRef.current = null;
        }
      }, 28);

    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Erreur inconnue';
      setChatHistory(prev => prev.map(en => en.id === entryId ? { ...en, error: msg } : en));
      setServerDown(true);
    } finally {
      setIsLoading(false);
      setTimeout(() => chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
  }, [onHighlightSources, onClearHighlights, answerScope]);

  // ── Web quick answer ─────────────────────────────────────────────────────

  const handleWebAnswer = useCallback(async (q: string) => {
    const entryId = generateId();
    setChatHistory(prev => [...prev, {
      id: entryId, query: q,
      webAnswer: { phase: 'searching', phaseMessage: 'Recherche en cours…' },
    }]);
    setTimeout(() => chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);

    try {
      await cortexClient.webAnswer(q, (evt) => {
        if (evt.type === 'status') {
          setChatHistory(prev => prev.map(e => e.id === entryId
            ? { ...e, webAnswer: { phase: evt.phase ?? 'searching', phaseMessage: evt.message } }
            : e,
          ));
        } else if (evt.type === 'result') {
          setChatHistory(prev => prev.map(e => e.id === entryId
            ? { ...e, webAnswer: { phase: 'done', answer: evt.answer, sources: evt.sources, modelUsed: evt.model_used, latencyMs: evt.latency_ms } }
            : e,
          ));
          setTimeout(() => chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
        } else if (evt.type === 'error') {
          setChatHistory(prev => prev.map(e => e.id === entryId
            ? { ...e, error: evt.error, webAnswer: { phase: 'error' } }
            : e,
          ));
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur réseau';
      setChatHistory(prev => prev.map(e => e.id === entryId
        ? { ...e, error: msg, webAnswer: { phase: 'error' } }
        : e,
      ));
    }
  }, []);

  // ── Web deep search (cherche) ────────────────────────────────────────────

  const startExploreA = useCallback(async (subject: string) => {
    setExploreState({ phase: 'a-running', pages: [], pageIndex: 0, pageTotal: 0, msg: 'Recherche DuckDuckGo…' });
    try {
      const { results } = await cortexClient.webResults(subject, 25);
      setExploreState(prev => prev ? { ...prev, phase: 'b-done', modeAResults: results, msg: '' } : prev);
      // 'b-done' reused as "done" state — no AI was involved
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur réseau';
      setExploreState(prev => prev ? { ...prev, phase: 'error', error: msg } : prev);
    }
  }, []);

  const startExploreB = useCallback(async (subject: string) => {
    const token = `explore-${Date.now()}`;
    exploreCancelTokenRef.current = token;
    const abortCtrl = new AbortController();
    exploreAbortRef.current = abortCtrl;

    setExploreState({ phase: 'b-running', pages: [], pageIndex: 0, pageTotal: 0, msg: 'Recherche DuckDuckGo…' });

    try {
      await cortexClient.webDeep(subject, 6, token, (evt) => {
        if (evt.type === 'status') {
          setExploreState(prev => prev ? {
            ...prev,
            msg:       evt.message ?? '',
            pageIndex: evt.index  ?? prev.pageIndex,
            pageTotal: evt.total  ?? prev.pageTotal,
          } : prev);
        } else if (evt.type === 'page') {
          setExploreState(prev => {
            if (!prev) return prev;
            const src: WebDeepSource = { title: evt.title ?? '', url: evt.url ?? '', domain: evt.domain ?? '', ok: evt.ok ?? false };
            return { ...prev, pages: [...prev.pages, src], pageIndex: evt.index ?? prev.pageIndex, pageTotal: evt.total ?? prev.pageTotal };
          });
        } else if (evt.type === 'result') {
          setExploreState(prev => prev ? {
            ...prev, phase: 'b-done',
            result: { content: evt.content ?? '', sources: evt.sources ?? [], modelUsed: evt.model_used, latencyMs: evt.latency_ms, cancelled: false },
          } : prev);
        } else if (evt.type === 'cancelled') {
          setExploreState(prev => prev ? {
            ...prev, phase: 'b-cancelled',
            result: evt.content
              ? { content: evt.content, sources: evt.sources ?? [], modelUsed: evt.model_used, latencyMs: evt.latency_ms, cancelled: true }
              : undefined,
          } : prev);
        } else if (evt.type === 'error') {
          setExploreState(prev => prev ? { ...prev, phase: 'error', error: evt.error } : prev);
        }
      }, abortCtrl.signal);
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        const msg = err instanceof Error ? err.message : 'Erreur réseau';
        setExploreState(prev => prev ? { ...prev, phase: 'error', error: msg } : prev);
      }
    }
  }, []);

  const cancelExplore = useCallback(() => {
    const token = exploreCancelTokenRef.current;
    if (token) {
      void cortexClient.cancelWebDeep(token);
      exploreCancelTokenRef.current = '';
    }
    exploreAbortRef.current?.abort();
    exploreAbortRef.current = null;
    setExploreSubject(null);
    setExploreState(null);
  }, []);

  // ── "corpus [sujet]" — recherche ciblée + capture manuelle sélective ────────

  const startCorpusSearch = useCallback(async (subject: string) => {
    setCorpusSearch({ subject, phase: 'loading', results: [], selected: new Set() });
    try {
      const trustedSites = getCorpusTrustedSites();
      let results: WebSearchResult[];
      if (trustedSites.length > 0) {
        const perSite = await Promise.all(
          trustedSites.map(site => cortexClient.webResults(`site:${site} ${subject}`, 25).then(r => r.results).catch(() => [])),
        );
        const seen = new Set<string>();
        results = perSite.flat().filter(r => {
          if (seen.has(r.url)) return false;
          seen.add(r.url);
          return true;
        }).slice(0, 25);
      } else {
        const r = await cortexClient.webResults(subject, 25);
        results = r.results;
      }
      setCorpusSearch({ subject, phase: 'results', results, selected: new Set() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur réseau';
      setCorpusSearch({ subject, phase: 'error', results: [], selected: new Set(), error: msg });
    }
  }, []);

  const toggleCorpusResult = useCallback((url: string) => {
    setCorpusSearch(prev => {
      if (!prev) return prev;
      const next = new Set(prev.selected);
      if (next.has(url)) next.delete(url); else next.add(url);
      return { ...prev, selected: next };
    });
  }, []);

  const setCorpusSelectAll = useCallback((all: boolean) => {
    setCorpusSearch(prev => {
      if (!prev) return prev;
      return { ...prev, selected: all ? new Set(prev.results.slice(0, CORPUS_MAX_SELECT).map(r => r.url)) : new Set() };
    });
  }, []);

  const confirmCorpusCapture = useCallback(async () => {
    if (!corpusSearch || corpusSearch.selected.size === 0) return;
    const subject = corpusSearch.subject;
    const urls    = [...corpusSearch.selected];
    setCorpusSearch(prev => prev ? { ...prev, phase: 'capturing', progress: { done: 0, total: urls.length } } : prev);

    try {
      const result = await cortexClient.corpusSearchCapture(subject, urls);
      corpusPollRef.current = setInterval(async () => {
        try {
          const job = await cortexClient.corpusJobStatus(result.jobId);
          setCorpusSearch(p => p ? { ...p, progress: { done: job.done, total: job.total } } : p);
          if (job.status !== 'running') {
            if (corpusPollRef.current) clearInterval(corpusPollRef.current);
            corpusPollRef.current = null;
            setCorpusSearch(p => p ? {
              ...p, phase: 'done',
              summary: { ok: job.total - job.errors.length, total: job.total, failures: job.errors },
            } : p);
          }
        } catch {
          if (corpusPollRef.current) clearInterval(corpusPollRef.current);
          corpusPollRef.current = null;
          setCorpusSearch(p => p ? { ...p, phase: 'error', error: 'Suivi de progression perdu' } : p);
        }
      }, 1000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur réseau';
      setCorpusSearch(p => p ? { ...p, phase: 'error', error: msg } : p);
    }
  }, [corpusSearch]);

  const cancelCorpusSearch = useCallback(() => {
    if (corpusPollRef.current) clearInterval(corpusPollRef.current);
    corpusPollRef.current = null;
    setCorpusSearch(null);
  }, []);

  useEffect(() => () => { if (corpusPollRef.current) clearInterval(corpusPollRef.current); }, []);

  // ── Question submit (mode QUESTION) ──────────────────────────────────────

  const handleResearchMode = useCallback((mode: 'synthese' | 'actualite') => {
    if (!researchSubject || researchLoading) return;
    const subject = researchSubject;
    setResearchSubject(null);
    onClose();
    // Fire-and-forget: App.tsx handles toast + page creation + error
    void onResearch(subject, mode);
  }, [researchSubject, researchLoading, onResearch, onClose]);

  const handleDeepResearchConfirm = useCallback((options: DeepResearchOptions) => {
    if (!deepResearchSubject) return;
    const subject = deepResearchSubject;
    setDeepResearchSubject(null);
    onClose();
    void onDeepResearch(subject, options);
  }, [deepResearchSubject, onDeepResearch, onClose]);

  const handleMultiSourceConfirm = useCallback((angles: number) => {
    if (!multiSourceSubject) return;
    const subject = multiSourceSubject;
    setMultiSourceSubject(null);
    onClose();
    void onMultiSourceResearch(subject, angles);
  }, [multiSourceSubject, onMultiSourceResearch, onClose]);

  const handleQuestion = useCallback(async (overrideQuery?: string) => {
    let q = (overrideQuery ?? query).trim();
    if (!q || isLoading || clarifyLoading) return;

    setCommandState(null);

    // ── "web [question]" — réponse web rapide (local, pas de neurone auto) ──
    const webMatch = WEB_RE.exec(q);
    if (webMatch) {
      setQuery('');
      void handleWebAnswer(webMatch[1].trim());
      return;
    }

    // ── "cherche [sujet]" — recherche web approfondie ────────────────────────
    const chercheMatch = CHERCHE_RE.exec(q);
    if (chercheMatch) {
      setQuery('');
      setExploreSubject(chercheMatch[1].trim());
      setExploreState({ phase: 'choosing', pages: [], pageIndex: 0, pageTotal: 0, msg: '' });
      return;
    }

    // ── "corpus [sujet]" — recherche ciblée + sélection manuelle pour le corpus de référence ──
    const corpusMatch = CORPUS_RE.exec(q);
    if (corpusMatch) {
      setQuery('');
      void startCorpusSearch(corpusMatch[1].trim());
      return;
    }

    // ── "compare [question]" — comparaison multi-modèles ─────────────────────
    const compareMatch = COMPARE_RE.exec(q);
    if (compareMatch) {
      const cq = compareMatch[1].trim();
      setQuery('');
      onCompare?.(cq);
      return;
    }

    // ── "lis [mots-clés]" — trouver un neurone vidéo et lancer le lecteur ──
    const lisMatch = LIS_RE.exec(q);
    if (lisMatch) {
      const keywords = lisMatch[1].trim();
      const kw  = keywords.toLowerCase();
      const kws = kw.split(/\s+/);
      const results: VideoHit[] = pages
        .flatMap(p => {
          const videoId = extractFirstYouTubeId(p);
          if (!videoId) return [];
          const titleScore   = kws.filter(w => p.title.toLowerCase().includes(w)).length;
          const contentScore = p.blocks?.some(b => kws.some(w => (b.content ?? '').toLowerCase().includes(w))) ? 1 : 0;
          if (titleScore === 0 && contentScore === 0) return [];
          return [{ page: p, videoId, score: titleScore * 2 + contentScore }];
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .map(({ page, videoId }) => ({ page, videoId }));

      setQuery('');
      if (results.length === 1) {
        onNavigate(results[0].page.id);
        onPlayVideo(results[0].videoId, results[0].page.title);
        onClose();
      } else {
        setCommandState({ type: 'lis', keywords, results });
      }
      return;
    }

    // ── "ouvre [url ou mots-clés]" — ouvrir dans un onglet ─────────────────
    const ouvreMatch = OUVRE_RE.exec(q);
    if (ouvreMatch) {
      const arg = ouvreMatch[1].trim();
      setQuery('');

      if (looksLikeUrl(arg)) {
        const url = ensureHttps(arg);
        const win = window.open(url, '_blank', 'noopener,noreferrer');
        if (win) { onClose(); return; }
        setCommandState({ type: 'ouvre', arg, url, hits: [] });
        return;
      }

      // Check shortcuts: custom shortcuts take priority over defaults
      const normalized = normalizeShortcutName(arg);
      const allShortcuts = { ...DEFAULT_SHORTCUTS, ...(customShortcuts ?? {}) };
      const shortcutUrl = allShortcuts[normalized];
      if (shortcutUrl) {
        const win = window.open(shortcutUrl, '_blank', 'noopener,noreferrer');
        if (win) { onClose(); return; }
        setCommandState({ type: 'ouvre', arg, url: shortcutUrl, hits: [] });
        return;
      }

      const kw  = arg.toLowerCase();
      const kws = kw.split(/\s+/);
      const hits: OuvreHit[] = pages
        .flatMap(p => {
          const sourceUrl = getPageSourceUrl(p);
          if (!sourceUrl) return [];
          const match = kws.some(w => p.title.toLowerCase().includes(w)) ||
                        p.blocks?.some(b => kws.some(w => (b.content ?? '').toLowerCase().includes(w)));
          return match ? [{ page: p, sourceUrl }] : [];
        })
        .slice(0, 6);

      if (hits.length === 0) {
        const suggestion = closestShortcutName(arg, allShortcuts) ?? undefined;
        setCommandState({
          type: 'ouvre', arg, url: null, hits: [],
          suggestion, suggestionUrl: suggestion ? allShortcuts[suggestion] : undefined,
        });
      } else if (hits.length === 1) {
        const win = window.open(hits[0].sourceUrl, '_blank', 'noopener,noreferrer');
        if (win) { onClose(); return; }
        setCommandState({ type: 'ouvre', arg, url: hits[0].sourceUrl, hits: [] });
      } else {
        setCommandState({ type: 'ouvre', arg, url: null, hits });
      }
      return;
    }

    if (offline) {
      const entryId  = generateId();
      const offlineMsg = 'Questions indisponibles hors-ligne — allumez le PC pour utiliser la recherche sémantique.';
      setChatHistory(prev => [...prev, { id: entryId, query: q, error: offlineMsg }]);
      setQuery('');
      return;
    }

    // Detect "pdf [sujet]" — export subject as PDF
    const pdfMatch = PDF_RE.exec(q);
    if (pdfMatch && onPdfSubject) {
      setQuery('');
      onClose();
      onPdfSubject(pdfMatch[1].trim());
      return;
    }

    // Detect "veille++ [sujet]" — multi-source cross-check (AVANT veille+ et veille simple)
    const multiSourceMatch = MULTI_SOURCE_RE.exec(q);
    if (multiSourceMatch) {
      setQuery('');
      setMultiSourceSubject(multiSourceMatch[1].trim());
      return;
    }

    // Detect "veille+ [sujet]" / "veille approfondie [sujet]" — AVANT veille simple
    const deepResearchMatch = DEEP_RESEARCH_RE.exec(q);
    if (deepResearchMatch) {
      setQuery('');
      setDeepResearchSubject(deepResearchMatch[1].trim());
      return;
    }

    // Detect "veille [sujet]" or "recherche [sujet]" prefix
    const researchMatch = RESEARCH_RE.exec(q);
    if (researchMatch) {
      setQuery('');
      setResearchSubject(researchMatch[1].trim());
      return;
    }

    // Detect "local [question]" / "privé [question]" prefix
    const localMatch = LOCAL_RE.exec(q);
    const forceLocal = localMode || !!localMatch;
    if (localMatch) q = localMatch[1].trim();

    // ── Clarification check (cloud-only, skipped in local mode) ────────────────
    if (!forceLocal) {
      if (!isDefinitelyDirect(q)) {
        stopTyping();
        setQuery('');
        setClarifyLoading(true);
        try {
          const cr = await cortexClient.clarify(q);
          if (cr.needs_clarification && cr.questions && cr.questions.length > 0) {
            setClarification({ query: q, forceLocal, questions: cr.questions, currentIdx: 0, answers: [] });
            setClarifyLoading(false);
            return;
          }
        } catch {
          // clarify failed → fall through to direct answer
        } finally {
          setClarifyLoading(false);
        }
      }
    }

    setQuery('');
    void submitDirectAnswer(q, forceLocal, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, isLoading, clarifyLoading, localMode, offline, pages, onNavigate, onClose, onPlayVideo, onHighlightSources, onClearHighlights, submitDirectAnswer, startCorpusSearch]);

  handleQuestionRef.current = handleQuestion;

  // ── Called when user answers the last clarification question ────────────────

  const handleClarificationDone = useCallback((answers: ClarifyAnswer[]) => {
    const state = clarification;
    setClarification(null);
    if (!state) return;
    void submitDirectAnswer(state.query, state.forceLocal, answers);
  }, [clarification, submitDirectAnswer]);

  // ── Skip clarification → answer directly ───────────────────────────────────

  const handleSkipClarification = useCallback(() => {
    const state = clarification;
    setClarification(null);
    if (!state) return;
    setQuery('');
    void submitDirectAnswer(state.query, state.forceLocal, []);
  }, [clarification, submitDirectAnswer]);

  // ── Input key handling ────────────────────────────────────────────────────

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (mode === 'question') {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleQuestion(); return; }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const next = Math.min(historyIdx + 1, queryHistory.length - 1);
        setHistoryIdx(next);
        if (queryHistory[next]) setQuery(queryHistory[next]);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = Math.max(historyIdx - 1, -1);
        setHistoryIdx(next);
        setQuery(next === -1 ? '' : queryHistory[next]);
      }
    }
  }

  function toggleKind(kind: PageKind) {
    setFilterKinds(prev => {
      const s = new Set(prev);
      if (s.has(kind)) s.delete(kind); else s.add(kind);
      return s;
    });
  }

  function clearSession() {
    setChatHistory([]);
    setTypingAnswer('');
    setCommandState(null);
    setClarification(null);
    stopTyping();
    onClearHighlights();
  }

  function handleResultClick(r: SearchHit) {
    onNavigate(r.id);
    onClose();
  }

  if (!isOpen) return null;

  const lastAnsweredIdx = chatHistory.length - 1;

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position:      'fixed',
        inset:          0,
        background:    'rgba(8, 6, 18, 0.93)',
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
        zIndex:         150,
        display:        'flex',
        alignItems:     'flex-start',
        justifyContent: 'center',
        paddingTop:     '7vh',
        animation:      'modal-fade-in 0.16s ease-out',
      }}
    >
      <div
        className="console-modal"
        style={{
          width:          '100%',
          maxWidth:        720,
          margin:         '0 16px',
          background:     'rgba(10, 8, 20, 0.99)',
          border:         '1px solid rgba(61,255,170,0.18)',
          borderRadius:    14,
          overflow:        'hidden',
          animation:       'modal-scale-in 0.16s ease-out',
          display:         'flex',
          flexDirection:   'column',
          maxHeight:       '82vh',
          boxShadow:       '0 32px 80px rgba(0,0,0,0.6)',
        }}
      >
        {/* ── Header ────────────────────────────────────────────────────── */}
        <div style={{
          display:        'flex',
          alignItems:     'center',
          gap:             10,
          padding:        '12px 16px',
          borderBottom:   '1px solid rgba(61,255,170,0.1)',
          flexShrink:      0,
        }}>
          <span className="font-grotesk font-semibold" style={{ color: '#3dffaa', fontSize: 11, letterSpacing: '0.2em' }}>
            CONSOLE
          </span>

          {/* Mode toggle */}
          <div style={{
            display:    'flex',
            gap:         2,
            background: 'rgba(61,255,170,0.05)',
            border:     '1px solid rgba(61,255,170,0.1)',
            borderRadius: 8,
            padding:     3,
          }}>
            {(['search', 'question'] as const).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                className="font-mono"
                style={{
                  fontSize:   10,
                  letterSpacing: '0.1em',
                  padding:    '4px 12px',
                  borderRadius: 5,
                  border:      'none',
                  cursor:      'pointer',
                  background:  mode === m ? 'rgba(61,255,170,0.16)' : 'transparent',
                  color:       mode === m ? '#3dffaa' : '#4a3a6a',
                  transition:  'all 0.14s',
                }}
              >
                {m === 'search' ? '⌕ RECHERCHE' : '◎ QUESTION'}
              </button>
            ))}
            {onOpenConversation && (
              <button
                type="button"
                onClick={onOpenConversation}
                className="font-mono"
                title="Discuter avec Docteur — conversation avec mémoire de contexte"
                style={{
                  fontSize:   10,
                  letterSpacing: '0.1em',
                  padding:    '4px 12px',
                  borderRadius: 5,
                  border:      'none',
                  cursor:      'pointer',
                  background:  'transparent',
                  color:       '#4a3a6a',
                  transition:  'all 0.14s',
                }}
              >
                ◈ DISCUSSION
              </button>
            )}
          </div>

          <span className="font-mono" style={{ fontSize: 9, color: '#2a2040', marginLeft: 'auto', letterSpacing: '0.08em' }}>
            Ctrl+K · Échap
          </span>

          {mode === 'question' && chatHistory.length > 0 && (
            <button type="button" onClick={clearSession} className="font-mono"
              style={{ fontSize: 9, color: '#3d3060', cursor: 'pointer', padding: '2px 6px', letterSpacing: '0.1em' }}>
              VIDER
            </button>
          )}

          <button type="button" onClick={onClose} style={{ color: '#3d3060', cursor: 'pointer', lineHeight: 0, padding: 2 }}>
            <X size={15} />
          </button>
        </div>

        {/* ── Input ─────────────────────────────────────────────────────── */}
        <div style={{ padding: '12px 16px 8px', flexShrink: 0 }}>
          <div style={{ position: 'relative' }}>
            <Search size={15} style={{
              position:  'absolute',
              left:       13,
              top:       '50%',
              transform: 'translateY(-50%)',
              color:     '#3d3060',
              pointerEvents: 'none',
            }} />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={e => void handleImagePaste(e)}
              placeholder={
                imagePasting ? 'Import de l\'image…' :
                mode === 'search'
                  ? 'Rechercher dans tes neurones…'
                  : localMode
                    ? '🔒 Mode local — pose ta question…'
                    : 'Question… · "web [?]" · "cherche [sujet]" · "lis [titre]" · "ouvre [url]"'
              }
              className="font-mono"
              style={{
                width:          '100%',
                height:          52,
                paddingLeft:     42,
                paddingRight:    40,
                background:     'rgba(61,255,170,0.035)',
                border:         '1px solid rgba(61,255,170,0.14)',
                borderRadius:    10,
                color:          '#f0eaff',
                fontSize:        14,
                outline:         'none',
                caretColor:     '#3dffaa',
                boxSizing:      'border-box',
                fontFamily:     'IBM Plex Mono, monospace',
              }}
            />
            {isLoading && (
              <div style={{ position: 'absolute', right: 13, top: '50%', transform: 'translateY(-50%)' }}>
                <div className="neural-dot" style={{ width: 5, height: 5 }} />
              </div>
            )}
          </div>
        </div>

        {/* ── Compare shortcut (question mode only) ─────────────────────── */}
        {mode === 'question' && onCompare && query.trim().length > 0 && !isLoading && (
          <div style={{ padding: '0 16px 8px', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => { const q = query.trim(); if (q) { setQuery(''); onCompare(q); } }}
              className="font-mono"
              style={{
                fontSize:   10, padding: '3px 10px', borderRadius: 6,
                border:     '1px solid rgba(94,231,255,0.2)',
                background: 'rgba(94,231,255,0.05)',
                color:      '#5ee7ff', cursor: 'pointer',
                letterSpacing: '0.06em',
              }}
            >
              ⊞ Comparer les modèles sur cette question
            </button>
          </div>
        )}

        {/* ── Kind filter (search only) ──────────────────────────────────── */}
        {mode === 'search' && (
          <div style={{ display: 'flex', gap: 5, padding: '0 16px 10px', flexWrap: 'wrap', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setFilterKinds(new Set())}
              className="font-mono"
              style={{
                fontSize:   10,
                padding:    '3px 10px',
                borderRadius: 20,
                border:     `1px solid ${filterKinds.size === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)'}`,
                background:  filterKinds.size === 0 ? 'rgba(255,255,255,0.07)' : 'transparent',
                color:       filterKinds.size === 0 ? '#e8d9ff' : '#4a3a6a',
                cursor:      'pointer',
              }}
            >
              Tout
            </button>
            {(Object.keys(KIND_META) as PageKind[]).map(kind => {
              const meta   = KIND_META[kind];
              const active = filterKinds.has(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => toggleKind(kind)}
                  className="font-mono"
                  style={{
                    fontSize:   10,
                    padding:    '3px 10px',
                    borderRadius: 20,
                    border:     `1px solid ${active ? meta.color + '66' : 'rgba(255,255,255,0.06)'}`,
                    background:  active ? `rgba(${hexRgb(meta.color)}, 0.12)` : 'transparent',
                    color:       active ? meta.color : '#4a3a6a',
                    cursor:      'pointer',
                    transition:  'all 0.13s',
                  }}
                >
                  {meta.icon} {meta.label}
                </button>
              );
            })}
          </div>
        )}

        {/* ── Results / Chat area ────────────────────────────────────────── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px' }}>

          {/* Server down banner */}
          {serverDown && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '32px 0' }}>
              <p className="font-mono" style={{ color: '#5a4a7a', fontSize: 11, textAlign: 'center' }}>
                Le serveur cognitif n'est pas disponible.
              </p>
              <button
                type="button"
                onClick={() => { setServerDown(false); setQuery(q => q + ' '); setTimeout(() => setQuery(q => q.trim()), 10); }}
                className="font-mono"
                style={{
                  fontSize: 11, padding: '5px 14px', borderRadius: 6,
                  border: '1px solid rgba(94,231,255,0.2)', background: 'transparent',
                  color: '#5ee7ff', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                <RefreshCw size={11} />
                Réessayer
              </button>
            </div>
          )}

          {/* ════ SEARCH MODE ════ */}
          {mode === 'search' && !serverDown && (
            <>
              {/* Empty state */}
              {query.trim().length < 2 && (
                <div style={{ padding: '36px 0', textAlign: 'center' }}>
                  <p className="font-mono" style={{ color: '#2a2040', fontSize: 11, lineHeight: 1.7 }}>
                    Tape au moins 2 caractères pour rechercher<br />
                    <span style={{ fontSize: 10 }}>
                      Recherche sémantique — le sens compte, pas les mots exacts
                    </span>
                  </p>
                </div>
              )}

              {/* No results */}
              {searchResults !== null && searchResults.length === 0 && (
                <NoResults query={query} onCreatePage={() => { onCreatePage(); onClose(); }} />
              )}

              {/* Results list */}
              {searchResults && searchResults.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <p className="font-mono" style={{ color: '#2e2555', fontSize: 9, letterSpacing: '0.14em', marginBottom: 4 }}>
                    {searchResults.length} RÉSULTAT{searchResults.length > 1 ? 'S' : ''}
                  </p>
                  {searchResults.map((r, i) => (
                    <SearchResultCard key={r.id ?? i} result={r} onClick={() => handleResultClick(r)} />
                  ))}
                </div>
              )}
            </>
          )}

          {/* ════ QUESTION MODE ════ */}
          {mode === 'question' && !serverDown && (
            <>
              {/* Local-powerful mode toggle */}
              <div className="console-local-bar">
                <button
                  type="button"
                  onClick={() => setLocalMode(v => !v)}
                  title="Force le modèle puissant (configurable dans Réglages) — aucun appel cloud, garanti privé"
                  className={`font-mono console-local-toggle${localMode ? ' console-local-toggle--active' : ''}`}
                >
                  🔒 Local puissant {localMode ? '(actif)' : ''}
                </button>
                {localMode && (
                  <span className="font-mono console-local-hint">
                    modèle puissant · aucun cloud · préfixe "local" aussi accepté
                  </span>
                )}
              </div>

              {/* RAG scope selector — mes neurones / références / les deux */}
              <div className="font-mono" style={{ display: 'flex', gap: 4, padding: '0 4px 8px' }}>
                {([
                  { v: 'all',       label: 'Tout' },
                  { v: 'personal',  label: 'Mes neurones' },
                  { v: 'reference', label: 'Références' },
                ] as const).map(opt => (
                  <button
                    key={opt.v}
                    type="button"
                    onClick={() => setAnswerScope(opt.v)}
                    title="Portée de la recherche RAG"
                    style={{
                      fontSize: 10, padding: '3px 9px', borderRadius: 20,
                      border: `1px solid ${answerScope === opt.v ? 'rgba(132,204,22,0.4)' : 'rgba(255,255,255,0.08)'}`,
                      background: answerScope === opt.v ? 'rgba(132,204,22,0.12)' : 'transparent',
                      color: answerScope === opt.v ? '#84cc16' : '#7a6c9a',
                      cursor: 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {/* Clarification loading */}
              {clarifyLoading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 4px' }}>
                  <DocteurAvatar />
                  <span className="font-mono" style={{ color: '#5a4a7a', fontSize: 12 }}>
                    Quelques précisions pour mieux te répondre<ThinkingDots />
                  </span>
                </div>
              )}

              {/* Clarification panel */}
              {clarification && !clarifyLoading && (
                <ClarificationPanel
                  state={clarification}
                  onAnswer={(answer) => {
                    const next = [...clarification.answers, answer];
                    if (clarification.currentIdx + 1 >= clarification.questions.length) {
                      handleClarificationDone(next);
                    } else {
                      setClarification({ ...clarification, currentIdx: clarification.currentIdx + 1, answers: next });
                    }
                  }}
                  onSkip={handleSkipClarification}
                />
              )}

              {/* Multi-source panel — shown when veille++ prefix detected */}
              {multiSourceSubject && (
                <MultiSourceResearchPanel
                  subject={multiSourceSubject}
                  onConfirm={handleMultiSourceConfirm}
                  onCancel={() => setMultiSourceSubject(null)}
                />
              )}

              {/* Deep research panel — shown when veille+/veille approfondie prefix detected */}
              {!multiSourceSubject && deepResearchSubject && (
                <DeepResearchPanel
                  subject={deepResearchSubject}
                  onConfirm={handleDeepResearchConfirm}
                  onCancel={() => setDeepResearchSubject(null)}
                />
              )}

              {/* Research choice panel — shown when veille/recherche prefix detected */}
              {!multiSourceSubject && !deepResearchSubject && researchSubject && (
                <ResearchChoicePanel
                  subject={researchSubject}
                  loading={researchLoading}
                  onChoose={handleResearchMode}
                  onMultiSource={() => { setMultiSourceSubject(researchSubject); setResearchSubject(null); }}
                  onCancel={() => setResearchSubject(null)}
                />
              )}

              {/* Explore panel — shown when cherche prefix detected */}
              {exploreSubject && exploreState && (
                <ExplorePanel
                  subject={exploreSubject}
                  state={exploreState}
                  onModeA={() => startExploreA(exploreSubject)}
                  onModeB={() => startExploreB(exploreSubject)}
                  onCancel={cancelExplore}
                  onSaveA={onCreateWebResultsNeuron
                    ? async () => {
                        if (exploreState.modeAResults) {
                          await onCreateWebResultsNeuron(exploreSubject, exploreState.modeAResults);
                          setExploreSubject(null);
                          setExploreState(null);
                        }
                      }
                    : undefined}
                  onSaveB={onCreateWebDeepNeuron
                    ? async () => {
                        if (exploreState.result) {
                          await onCreateWebDeepNeuron(exploreSubject, exploreState.result.content, exploreState.result.sources, exploreState.result.cancelled);
                          setExploreSubject(null);
                          setExploreState(null);
                        }
                      }
                    : undefined}
                />
              )}

              {corpusSearch && (
                <CorpusSearchPanel
                  state={corpusSearch}
                  pages={pages}
                  onToggle={toggleCorpusResult}
                  onSelectAll={() => setCorpusSelectAll(true)}
                  onSelectNone={() => setCorpusSelectAll(false)}
                  onConfirm={() => { void confirmCorpusCapture(); }}
                  onCancel={cancelCorpusSearch}
                  onRetry={() => { void startCorpusSearch(corpusSearch.subject); }}
                />
              )}

              {commandState && (
                <CommandResultPanel
                  state={commandState}
                  onNavigate={onNavigate}
                  onPlayVideo={onPlayVideo}
                  onClose={onClose}
                  onClear={() => setCommandState(null)}
                />
              )}

              {!researchSubject && !commandState && !clarification && !clarifyLoading && chatHistory.length === 0 && !isLoading && (
                <div style={{ padding: '36px 0', textAlign: 'center' }}>
                  <p className="font-mono" style={{ color: '#2a2040', fontSize: 11, lineHeight: 1.9 }}>
                    Pose une question en langage naturel.<br />
                    <span style={{ color: '#1e1535', fontSize: 10 }}>
                      "Quel est mon code wifi ?"<br />
                      "Résume mes notes sur React"<br />
                      "web [question]" → 🌐 réponse web rapide<br />
                      "cherche [sujet]" → 🔍 recherche web approfondie<br />
                      "veille stockage d'énergie" → synthèse IA<br />
                      "pdf [sujet]" → 📄 export PDF du sujet<br />
                      "puissant [question]" → 🔒 modèle puissant (configurable)<br />
                      "lis [titre]" → ▶ lecteur vidéo intégré<br />
                      "ouvre youtube" → raccourci site<br />
                      "ouvre [url ou neurone]" → ouvrir dans un onglet
                    </span>
                  </p>
                </div>
              )}

              {!researchSubject && !clarification && chatHistory.map((entry, idx) => {
                // ── Web answer entry ──────────────────────────────────────────
                if (entry.webAnswer) {
                  const wa = entry.webAnswer;
                  const isDone  = wa.phase === 'done';
                  const isError = wa.phase === 'error';
                  return (
                    <div key={entry.id} style={{ marginBottom: 20 }}>
                      {/* Question */}
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                        <div className="font-mono" style={{
                          background: 'rgba(94,231,255,0.05)',
                          border:     '1px solid rgba(94,231,255,0.12)',
                          borderRadius: '10px 10px 3px 10px',
                          padding: '8px 14px', maxWidth: '85%',
                          color: '#b0a0d0', fontSize: 13, lineHeight: 1.5,
                        }}>
                          🌐 {entry.query}
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 10 }}>
                        <DocteurAvatar />
                        <div style={{ flex: 1 }}>
                          {/* Loading phases */}
                          {!isDone && !isError && (
                            <span className="font-mono" style={{ color: '#5a4a7a', fontSize: 12 }}>
                              {wa.phaseMessage ?? 'En cours…'}<ThinkingDots />
                            </span>
                          )}

                          {/* Error */}
                          {(isError || entry.error) && (
                            <div className="font-mono" style={{
                              padding: '10px 14px', borderRadius: 8,
                              border: '1px solid rgba(255,77,88,0.2)',
                              background: 'rgba(255,77,88,0.04)',
                              color: '#ff4d58', fontSize: 12,
                            }}>
                              {entry.error ?? 'Erreur inconnue'}
                            </div>
                          )}

                          {/* Result */}
                          {isDone && wa.answer && (
                            <>
                              <MarkdownContent
                                text={wa.answer}
                                textStyle={{ fontSize: 13, color: '#c8b8e8', lineHeight: 1.75, fontFamily: 'inherit' }}
                              />

                              {/* Source links */}
                              {wa.sources && wa.sources.length > 0 && (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 10 }}>
                                  {wa.sources.map((src, si) => (
                                    <a
                                      key={si}
                                      href={src.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="font-mono"
                                      style={{
                                        fontSize: 10, padding: '3px 10px', borderRadius: 20,
                                        border: '1px solid rgba(94,231,255,0.2)',
                                        background: 'rgba(94,231,255,0.06)',
                                        color: '#5ee7ff', textDecoration: 'none',
                                        display: 'inline-flex', alignItems: 'center', gap: 4,
                                      }}
                                    >
                                      <Globe size={9} /> {src.domain}
                                    </a>
                                  ))}
                                </div>
                              )}

                              {/* Footer */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                                <p className="font-mono" style={{ color: '#2e2555', fontSize: 9, flex: 1, letterSpacing: '0.06em' }}>
                                  {wa.sources?.length ?? 0} source{(wa.sources?.length ?? 0) > 1 ? 's' : ''} web
                                  {wa.modelUsed ? ` · ${wa.modelUsed.split(':')[0]} · local` : ''}
                                  {wa.latencyMs ? ` · ${(wa.latencyMs / 1000).toFixed(1)}s` : ''}
                                </p>
                                {onSaveWebAnswer && (
                                  <SaveButton
                                    saved={savedEntries.has(entry.id)}
                                    saving={savingEntry === entry.id}
                                    onSave={async () => {
                                      setSavingEntry(entry.id);
                                      try {
                                        await onSaveWebAnswer(entry.query, wa.answer!, wa.sources ?? []);
                                        setSavedEntries(prev => new Set(prev).add(entry.id));
                                      } finally {
                                        setSavingEntry(null);
                                      }
                                    }}
                                  />
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                }

                // ── Normal Q&A entry ──────────────────────────────────────────
                const isLastEntry = idx === lastAnsweredIdx;
                const showTyping  = isLastEntry && entry.answer && typingIntervalRef.current !== null;
                const displayText = isLastEntry && entry.answer
                  ? (typingAnswer.length > 0 ? typingAnswer : entry.answer.answer)
                  : entry.answer?.answer;

                return (
                  <div key={entry.id} style={{ marginBottom: 20 }}>
                    {/* Question */}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                      <div className="font-mono" style={{
                        background: 'rgba(61,255,170,0.06)',
                        border:     '1px solid rgba(61,255,170,0.12)',
                        borderRadius: '10px 10px 3px 10px',
                        padding:    '8px 14px',
                        maxWidth:   '85%',
                        color:      '#b0a0d0',
                        fontSize:    13,
                        lineHeight:  1.5,
                      }}>
                        {entry.query}
                      </div>
                    </div>

                    {/* Loading */}
                    {isLastEntry && isLoading && !entry.answer && !entry.error && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 4 }}>
                        <DocteurAvatar />
                        <span className="font-mono" style={{ color: '#5a4a7a', fontSize: 12 }}>
                          {entry.forceLocal
                            ? <>🔒 Modèle puissant, réponse plus lente<ThinkingDots /></>
                            : <>Docteur réfléchit<ThinkingDots /></>
                          }
                        </span>
                      </div>
                    )}

                    {/* Error */}
                    {entry.error && (
                      <div className="font-mono" style={{
                        padding: '10px 14px', borderRadius: 8,
                        border: '1px solid rgba(255,77,88,0.2)',
                        background: 'rgba(255,77,88,0.04)',
                        color: '#ff4d58', fontSize: 12,
                      }}>
                        {entry.error}
                      </div>
                    )}

                    {/* Answer */}
                    {entry.answer && displayText && (
                      <div style={{ display: 'flex', gap: 10 }}>
                        <DocteurAvatar />
                        <div style={{ flex: 1 }}>
                          {showTyping ? (
                            <p className="font-mono" style={{
                              color: '#c8b8e8', fontSize: 13, lineHeight: 1.75,
                              margin: 0, whiteSpace: 'pre-wrap',
                            }}>
                              {displayText}
                              <span style={{ opacity: 0.5, animation: 'neural-blink 0.8s infinite' }}>|</span>
                            </p>
                          ) : (
                            <MarkdownContent
                              text={displayText}
                              textStyle={{ fontSize: 13, color: '#c8b8e8', lineHeight: 1.75, fontFamily: 'inherit' }}
                            />
                          )}

                          {/* Source pills */}
                          {entry.answer.sources.length > 0 && !showTyping && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 10 }}>
                              {entry.answer.sources.map((src, si) => {
                                const pg   = pages.find(p => p.id === src.id || p.title === src.title);
                                const kind = pg?.kind ?? (src.kind as PageKind | undefined) ?? 'note';
                                const meta = KIND_META[kind] ?? KIND_META.note;
                                return (
                                  <button
                                    key={si}
                                    type="button"
                                    onClick={() => { if (pg) { onNavigate(pg.id); onClose(); } }}
                                    className="font-mono"
                                    style={{
                                      fontSize:    10,
                                      padding:    '3px 10px',
                                      borderRadius: 20,
                                      border:     `1px solid ${meta.color}44`,
                                      background: `rgba(${hexRgb(meta.color)}, 0.08)`,
                                      color:       meta.color,
                                      cursor:      pg ? 'pointer' : 'default',
                                    }}
                                  >
                                    {meta.icon} {src.title}
                                  </button>
                                );
                              })}
                            </div>
                          )}

                          {/* Footer */}
                          {!showTyping && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                              <p className="font-mono" style={{ color: '#2e2555', fontSize: 9, flex: 1, letterSpacing: '0.06em' }}>
                                Synthétisé à partir de {entry.answer.sources.length} neurone{entry.answer.sources.length > 1 ? 's' : ''}
                                {entry.answer.latency_ms ? ` · ${(entry.answer.latency_ms / 1000).toFixed(1)}s` : ''}
                                {entry.answer.model_used && (
                                  entry.answer.has_private_sources || entry.answer.routing_reason?.startsWith('privé') ? (
                                    <span style={{ marginLeft: 6, color: '#f472b6', fontFamily: 'monospace', fontSize: 9 }}>
                                      · 🔒 {entry.answer.model_used.split(':')[0]} · local · neurones privés
                                    </span>
                                  ) : (
                                    <span
                                      title={entry.answer.router_level ? `Niveau ${entry.answer.router_level} (router automatique)` : 'Modèle fixe'}
                                      style={{ marginLeft: 6, color: '#3d3060', cursor: 'help' }}
                                    >
                                      · {entry.answer.model_used.split(':')[0]}
                                      {entry.answer.router_level ? ` L${entry.answer.router_level}` : ''}
                                      {entry.answer.routing_reason ? ` · ${entry.answer.routing_reason}` : ''}
                                    </span>
                                  )
                                )}
                              </p>

                              {/* Save button — only once per entry */}
                              <SaveButton
                                saved={savedEntries.has(entry.id)}
                                saving={savingEntry === entry.id}
                                onSave={async () => {
                                  setSavingEntry(entry.id);
                                  try {
                                    await onSaveQR(entry.query, entry.answer!, entry.clarificationContext);
                                    setSavedEntries(prev => new Set(prev).add(entry.id));
                                  } finally {
                                    setSavingEntry(null);
                                  }
                                }}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {!researchSubject && <div ref={chatBottomRef} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function DocteurAvatar() {
  return (
    <div style={{
      width: 26, height: 26,
      borderRadius: '50%',
      background: 'rgba(61,255,170,0.1)',
      border: '1px solid rgba(61,255,170,0.2)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, marginTop: 2,
    }}>
      <span style={{ color: '#3dffaa', fontSize: 11, fontFamily: 'IBM Plex Mono, monospace' }}>D</span>
    </div>
  );
}

function ThinkingDots() {
  return (
    <span style={{ display: 'inline-flex', gap: 2, marginLeft: 4 }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          display: 'inline-block',
          width: 3, height: 3,
          borderRadius: '50%',
          background: '#5a4a7a',
          animation: `neural-blink 1.2s ease-in-out ${i * 0.2}s infinite`,
        }} />
      ))}
    </span>
  );
}

interface SaveButtonProps {
  readonly saved:   boolean;
  readonly saving:  boolean;
  readonly onSave:  () => Promise<void>;
}

function SaveButton({ saved, saving, onSave }: SaveButtonProps) {
  let icon: React.ReactNode;
  let label: string;
  if (saved) {
    icon  = <BookmarkCheck size={9} />;
    label = 'Sauvegardé';
  } else if (saving) {
    icon  = <RefreshCw size={9} className="animate-spin" />;
    label = '…';
  } else {
    icon  = <Bookmark size={9} />;
    label = 'Sauvegarder';
  }

  return (
    <button
      type="button"
      disabled={saved || saving}
      onClick={onSave}
      title={saved ? 'Déjà sauvegardé' : 'Sauvegarder cette réponse'}
      className="font-mono flex items-center gap-1"
      style={{
        fontSize:      9,
        padding:       '3px 8px',
        borderRadius:  5,
        border:        `1px solid ${saved ? 'rgba(0,212,177,0.25)' : 'rgba(0,212,177,0.15)'}`,
        background:     saved ? 'rgba(0,212,177,0.1)' : 'transparent',
        color:          saved ? '#00d4b1' : '#3d3060',
        cursor:         saved || saving ? 'default' : 'pointer',
        flexShrink:     0,
        letterSpacing: '0.06em',
        transition:    'all 0.15s',
      }}
    >
      {icon} {label}
    </button>
  );
}

// ── DeepResearchPanel ─────────────────────────────────────────────────────────

interface DeepResearchPanelProps {
  subject:   string;
  onConfirm: (options: DeepResearchOptions) => void;
  onCancel:  () => void;
}

function DeepResearchPanel({ subject, onConfirm, onCancel }: DeepResearchPanelProps) {
  const [format, setFormat] = useState<'document' | 'arborescence'>('arborescence');
  const [depth,  setDepth]  = useState<5 | 10 | 15>(5);
  const [source, setSource] = useState<'ia' | 'web'>('ia');
  const [quota,  setQuota]  = useState<ResearchQuota | null>(null);

  useEffect(() => {
    if (source === 'web') {
      cortexClient.getResearchQuota().then(setQuota).catch(() => null);
    }
  }, [source]);

  const estimatedCalls = format === 'document' ? 1 : 1 + depth;
  const quotaOk = source !== 'web' || !quota || quota.groundingRemaining >= estimatedCalls;
  const quotaWarn = source === 'web' && quota && quota.groundingRemaining < estimatedCalls && quota.groundingRemaining > 0;

  const BTN_BASE: React.CSSProperties = {
    flex: 1, padding: '8px 12px', borderRadius: 7, cursor: 'pointer',
    fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, fontWeight: 600,
    transition: 'all 0.12s', textAlign: 'left' as const,
  };
  const BTN_ON:  React.CSSProperties = { ...BTN_BASE, background: 'rgba(167,139,250,0.15)', border: '1px solid rgba(167,139,250,0.5)', color: '#a78bfa' };
  const BTN_OFF: React.CSSProperties = { ...BTN_BASE, background: 'transparent', border: '1px solid rgba(61,45,90,0.5)', color: '#5a4a7a' };

  function depthBtn(v: 5 | 10 | 15, label: string) {
    const on = depth === v;
    return (
      <button type="button" key={v} style={on ? BTN_ON : BTN_OFF}
        onClick={() => setDepth(v)}
        onMouseEnter={e => { if (!on) e.currentTarget.style.borderColor = 'rgba(167,139,250,0.3)'; }}
        onMouseLeave={e => { if (!on) e.currentTarget.style.borderColor = 'rgba(61,45,90,0.5)'; }}
      >{label}</button>
    );
  }

  return (
    <div style={{
      margin: '16px 0', padding: '18px 20px',
      background: 'rgba(167,139,250,0.04)', border: '1px solid rgba(167,139,250,0.2)',
      borderRadius: 10,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <p className="font-mono" style={{ color: '#a78bfa', fontSize: 10, letterSpacing: '0.14em', marginBottom: 4 }}>
            ⌖ VEILLE APPROFONDIE
          </p>
          <p className="font-grotesk font-semibold" style={{ color: '#f0eaff', fontSize: 13, maxWidth: 480 }}>
            {subject}
          </p>
        </div>
        <button type="button" onClick={onCancel} title="Annuler" style={{ color: '#3d3060', cursor: 'pointer', padding: 2 }}>
          <X size={13} />
        </button>
      </div>

      {/* Format */}
      <div style={{ marginBottom: 12 }}>
        <p className="font-mono" style={{ color: '#7060a0', fontSize: 10, letterSpacing: '0.1em', marginBottom: 6 }}>FORMAT</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={format === 'document' ? BTN_ON : BTN_OFF}
            onClick={() => setFormat('document')}
            onMouseEnter={e => { if (format !== 'document') e.currentTarget.style.borderColor = 'rgba(167,139,250,0.3)'; }}
            onMouseLeave={e => { if (format !== 'document') e.currentTarget.style.borderColor = 'rgba(61,45,90,0.5)'; }}
          >
            <div>Document unique</div>
            <div style={{ fontSize: 10, fontWeight: 400, color: format === 'document' ? '#7060a0' : '#3d2d5a', marginTop: 2 }}>Un neurone long et structuré</div>
          </button>
          <button type="button" style={format === 'arborescence' ? BTN_ON : BTN_OFF}
            onClick={() => setFormat('arborescence')}
            onMouseEnter={e => { if (format !== 'arborescence') e.currentTarget.style.borderColor = 'rgba(167,139,250,0.3)'; }}
            onMouseLeave={e => { if (format !== 'arborescence') e.currentTarget.style.borderColor = 'rgba(61,45,90,0.5)'; }}
          >
            <div>Arborescence</div>
            <div style={{ fontSize: 10, fontWeight: 400, color: format === 'arborescence' ? '#7060a0' : '#3d2d5a', marginTop: 2 }}>Parent + {depth} sous-neurones reliés</div>
          </button>
        </div>
      </div>

      {/* Depth */}
      <div style={{ marginBottom: 12 }}>
        <p className="font-mono" style={{ color: '#7060a0', fontSize: 10, letterSpacing: '0.1em', marginBottom: 6 }}>
          PROFONDEUR{format === 'document' ? ' (sections)' : ' (sous-neurones)'}
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          {depthBtn(5,  'Légère · 5')}
          {depthBtn(10, 'Moyenne · 10')}
          {depthBtn(15, 'Complète · 15')}
        </div>
      </div>

      {/* Source */}
      <div style={{ marginBottom: 14 }}>
        <p className="font-mono" style={{ color: '#7060a0', fontSize: 10, letterSpacing: '0.1em', marginBottom: 6 }}>SOURCE</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={source === 'ia' ? BTN_ON : BTN_OFF}
            onClick={() => setSource('ia')}
            onMouseEnter={e => { if (source !== 'ia') e.currentTarget.style.borderColor = 'rgba(167,139,250,0.3)'; }}
            onMouseLeave={e => { if (source !== 'ia') e.currentTarget.style.borderColor = 'rgba(61,45,90,0.5)'; }}
          >
            <div>Connaissances IA</div>
            <div style={{ fontSize: 10, fontWeight: 400, color: source === 'ia' ? '#7060a0' : '#3d2d5a', marginTop: 2 }}>Synthèse rapide, sans quota</div>
          </button>
          <button type="button" style={source === 'web' ? BTN_ON : BTN_OFF}
            onClick={() => setSource('web')}
            onMouseEnter={e => { if (source !== 'web') e.currentTarget.style.borderColor = 'rgba(167,139,250,0.3)'; }}
            onMouseLeave={e => { if (source !== 'web') e.currentTarget.style.borderColor = 'rgba(61,45,90,0.5)'; }}
          >
            <div>Avec recherche web</div>
            <div style={{ fontSize: 10, fontWeight: 400, color: source === 'web' ? '#7060a0' : '#3d2d5a', marginTop: 2 }}>Sources récentes · quota 20/jour</div>
          </button>
        </div>
      </div>

      {/* Estimation + quota */}
      <div style={{
        padding: '10px 14px', borderRadius: 7,
        background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(61,45,90,0.4)',
        marginBottom: 14,
      }}>
        <p className="font-mono" style={{ color: '#c8b8e8', fontSize: 11 }}>
          {format === 'document'
            ? `Estimation : 1 appel IA${source === 'web' ? ' grounding web' : ''} — document long`
            : `Estimation : ${estimatedCalls} appels${source === 'web' ? ' grounding web' : ' IA'} (1 plan + ${depth} sections)`}
        </p>
        {source === 'web' && quota && (
          <p className="font-mono" style={{ color: quotaOk ? '#7060a0' : '#ff4d58', fontSize: 10, marginTop: 4 }}>
            {quotaWarn
              ? `⚠ Quota insuffisant — ${quota.groundingRemaining} requête(s) restantes sur ${quota.groundingLimit}/jour`
              : `Quota web : ${quota.groundingRemaining}/${quota.groundingLimit} requêtes disponibles aujourd'hui`}
          </p>
        )}
        {source === 'web' && !quota && (
          <p className="font-mono" style={{ color: '#5a4a7a', fontSize: 10, marginTop: 4 }}>Vérification du quota…</p>
        )}
        {source === 'web' && quota && quota.groundingRemaining === 0 && (
          <p className="font-mono" style={{ color: '#ff4d58', fontSize: 10, marginTop: 4 }}>
            Quota épuisé pour aujourd'hui — utilise "Connaissances IA" ou réessaie demain.
          </p>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          disabled={!quotaOk}
          onClick={() => onConfirm({ format, depth, source })}
          style={{
            flex: 1, padding: '9px 16px', borderRadius: 7, cursor: quotaOk ? 'pointer' : 'not-allowed',
            fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, fontWeight: 600,
            background: quotaOk ? 'rgba(167,139,250,0.15)' : 'rgba(61,45,90,0.2)',
            border: quotaOk ? '1px solid rgba(167,139,250,0.4)' : '1px solid rgba(61,45,90,0.3)',
            color: quotaOk ? '#a78bfa' : '#3d2d5a',
            transition: 'all 0.12s',
          }}
          onMouseEnter={e => { if (quotaOk) { e.currentTarget.style.background = 'rgba(167,139,250,0.25)'; e.currentTarget.style.borderColor = 'rgba(167,139,250,0.6)'; } }}
          onMouseLeave={e => { if (quotaOk) { e.currentTarget.style.background = 'rgba(167,139,250,0.15)'; e.currentTarget.style.borderColor = 'rgba(167,139,250,0.4)'; } }}
        >
          Lancer la veille approfondie
        </button>
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: '9px 14px', borderRadius: 7, cursor: 'pointer',
            fontFamily: 'IBM Plex Mono, monospace', fontSize: 11,
            background: 'transparent', border: '1px solid rgba(61,45,90,0.4)', color: '#5a4a7a',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#7060a0'; e.currentTarget.style.color = '#9080c0'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(61,45,90,0.4)'; e.currentTarget.style.color = '#5a4a7a'; }}
        >
          Annuler
        </button>
      </div>
    </div>
  );
}

// ── MultiSourceResearchPanel ──────────────────────────────────────────────────

interface MultiSourceResearchPanelProps {
  subject:   string;
  onConfirm: (angles: number) => void;
  onCancel:  () => void;
}

function MultiSourceResearchPanel({ subject, onConfirm, onCancel }: MultiSourceResearchPanelProps) {
  const [angles, setAngles] = useState<3 | 4 | 5>(4);
  const [quota,  setQuota]  = useState<ResearchQuota | null>(null);

  useEffect(() => {
    cortexClient.getResearchQuota().then(setQuota).catch(() => null);
  }, []);

  // 1 plan call (cascade, no grounding) + N grounding calls + 1 crosscheck (cascade)
  const groundingCalls = angles;
  const quotaOk        = !quota || quota.groundingRemaining >= groundingCalls;

  const BTN_ON:  React.CSSProperties = { flex: 1, padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, fontWeight: 600, background: 'rgba(61,255,170,0.12)', border: '1px solid rgba(61,255,170,0.45)', color: '#3dffaa', textAlign: 'center' as const };
  const BTN_OFF: React.CSSProperties = { ...BTN_ON, background: 'transparent', border: '1px solid rgba(30,50,40,0.6)', color: '#2a5040' };

  return (
    <div style={{ margin: '16px 0', padding: '18px 20px', background: 'rgba(61,255,170,0.03)', border: '1px solid rgba(61,255,170,0.2)', borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <p className="font-mono" style={{ color: '#3dffaa', fontSize: 10, letterSpacing: '0.14em', marginBottom: 4 }}>⊕ VEILLE MULTI-SOURCES</p>
          <p className="font-grotesk font-semibold" style={{ color: '#f0eaff', fontSize: 13, maxWidth: 480 }}>{subject}</p>
        </div>
        <button type="button" onClick={onCancel} title="Annuler" style={{ color: '#1a4a30', cursor: 'pointer', padding: 2 }}>
          <X size={13} />
        </button>
      </div>

      <div style={{ marginBottom: 12 }}>
        <p className="font-mono" style={{ color: '#1a6040', fontSize: 10, letterSpacing: '0.1em', marginBottom: 6 }}>NOMBRE D'ANGLES</p>
        <div style={{ display: 'flex', gap: 8 }}>
          {([3, 4, 5] as const).map(n => (
            <button key={n} type="button" style={angles === n ? BTN_ON : BTN_OFF} onClick={() => setAngles(n)}>{n} angles</button>
          ))}
        </div>
      </div>

      <div style={{ padding: '10px 14px', borderRadius: 7, background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(30,50,40,0.5)', marginBottom: 14 }}>
        <p className="font-mono" style={{ color: '#c8ffe8', fontSize: 11 }}>
          Estimation : 1 plan + {groundingCalls} recherches web + 1 recoupement = <strong>{groundingCalls}</strong> appels grounding
        </p>
        {quota ? (
          <p className="font-mono" style={{ color: quotaOk ? '#1a6040' : '#ff4d58', fontSize: 10, marginTop: 4 }}>
            {quotaOk
              ? `Quota web : ${quota.groundingRemaining}/${quota.groundingLimit} requêtes disponibles aujourd'hui`
              : `⚠ Quota insuffisant — ${quota.groundingRemaining} requête(s) restante(s), ${groundingCalls} nécessaires`}
          </p>
        ) : (
          <p className="font-mono" style={{ color: '#1a4a30', fontSize: 10, marginTop: 4 }}>Vérification du quota…</p>
        )}
      </div>

      <p className="font-mono" style={{ color: '#1a5030', fontSize: 10, marginBottom: 14, lineHeight: 1.6 }}>
        Produit un neurone avec convergences, divergences, sources uniques et zones d'ombre.<br />
        Si le quota est épuisé en cours, le résultat partiel est conservé.
      </p>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          disabled={!quotaOk}
          onClick={() => onConfirm(angles)}
          className="font-mono"
          style={{
            flex: 1, padding: '9px 16px', borderRadius: 7, fontWeight: 600, fontSize: 11,
            cursor: quotaOk ? 'pointer' : 'not-allowed',
            background: quotaOk ? 'rgba(61,255,170,0.12)' : 'rgba(30,50,40,0.15)',
            border: quotaOk ? '1px solid rgba(61,255,170,0.4)' : '1px solid rgba(30,50,40,0.3)',
            color: quotaOk ? '#3dffaa' : '#1a4a30',
          }}
          onMouseEnter={e => { if (quotaOk) { e.currentTarget.style.background = 'rgba(61,255,170,0.2)'; e.currentTarget.style.borderColor = 'rgba(61,255,170,0.6)'; } }}
          onMouseLeave={e => { if (quotaOk) { e.currentTarget.style.background = 'rgba(61,255,170,0.12)'; e.currentTarget.style.borderColor = 'rgba(61,255,170,0.4)'; } }}
        >
          Lancer le recoupement
        </button>
        <button type="button" onClick={onCancel} className="font-mono"
          style={{ padding: '9px 14px', borderRadius: 7, fontSize: 11, background: 'transparent', border: '1px solid rgba(30,50,40,0.4)', color: '#1a6040', cursor: 'pointer' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#3dffaa'; e.currentTarget.style.color = '#3dffaa'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(30,50,40,0.4)'; e.currentTarget.style.color = '#1a6040'; }}
        >Annuler</button>
      </div>
    </div>
  );
}

interface ResearchChoicePanelProps {
  subject:         string;
  loading:         boolean;
  onChoose:        (mode: 'synthese' | 'actualite') => void;
  onMultiSource:   () => void;
  onCancel:        () => void;
}

function ResearchChoicePanel({ subject, loading, onChoose, onMultiSource, onCancel }: ResearchChoicePanelProps) {
  return (
    <div style={{
      margin:       '16px 0',
      padding:      '18px 20px',
      background:   'rgba(245,158,11,0.05)',
      border:       '1px solid rgba(245,158,11,0.2)',
      borderRadius:  10,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <p className="font-mono" style={{ color: '#f59e0b', fontSize: 10, letterSpacing: '0.14em', marginBottom: 4 }}>
            ⌖ VEILLE IA DÉTECTÉE
          </p>
          <p className="font-grotesk font-semibold" style={{ color: '#f0eaff', fontSize: 13, maxWidth: 480 }}>
            {subject}
          </p>
        </div>
        {!loading && (
          <button type="button" onClick={onCancel} title="Annuler" style={{ color: '#3d3060', cursor: 'pointer', padding: 2 }}>
            <X size={13} />
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="neural-dot" style={{ width: 5, height: 5 }} />
          <span className="font-mono" style={{ color: '#f59e0b', fontSize: 11 }}>
            Génération en cours<ThinkingDots />
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="button"
            onClick={() => onChoose('synthese')}
            className="font-mono"
            style={{
              flex:         1,
              display:      'flex',
              alignItems:   'center',
              gap:           8,
              padding:      '10px 16px',
              borderRadius:  8,
              border:       '1px solid rgba(94,231,255,0.2)',
              background:   'rgba(94,231,255,0.04)',
              color:        '#5ee7ff',
              cursor:       'pointer',
              textAlign:    'left',
              transition:   'all 0.13s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(94,231,255,0.1)'; e.currentTarget.style.borderColor = 'rgba(94,231,255,0.35)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(94,231,255,0.04)'; e.currentTarget.style.borderColor = 'rgba(94,231,255,0.2)'; }}
          >
            <BookOpen size={14} style={{ flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 2 }}>Synthèse de fond</div>
              <div style={{ fontSize: 10, color: '#3d6080', lineHeight: 1.4 }}>Vue d'ensemble structurée à partir des connaissances de l'IA</div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => onChoose('actualite')}
            className="font-mono"
            style={{
              flex:         1,
              display:      'flex',
              alignItems:   'center',
              gap:           8,
              padding:      '10px 16px',
              borderRadius:  8,
              border:       '1px solid rgba(245,158,11,0.2)',
              background:   'rgba(245,158,11,0.04)',
              color:        '#f59e0b',
              cursor:       'pointer',
              textAlign:    'left',
              transition:   'all 0.13s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(245,158,11,0.1)'; e.currentTarget.style.borderColor = 'rgba(245,158,11,0.35)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(245,158,11,0.04)'; e.currentTarget.style.borderColor = 'rgba(245,158,11,0.2)'; }}
          >
            <Globe size={14} style={{ flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 2 }}>Actualité récente</div>
              <div style={{ fontSize: 10, color: '#604020', lineHeight: 1.4 }}>Recherche web (Google Search) avec sources cliquables</div>
            </div>
          </button>
        </div>
      )}

      {/* Multi-source shortcut — always visible, not blocked by loading */}
      {!loading && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(61,45,90,0.3)' }}>
          <button
            type="button"
            onClick={onMultiSource}
            className="font-mono"
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 14px', borderRadius: 8, textAlign: 'left',
              border: '1px solid rgba(61,255,170,0.2)', background: 'rgba(61,255,170,0.04)',
              color: '#3dffaa', cursor: 'pointer', transition: 'all 0.13s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(61,255,170,0.08)'; e.currentTarget.style.borderColor = 'rgba(61,255,170,0.35)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(61,255,170,0.04)'; e.currentTarget.style.borderColor = 'rgba(61,255,170,0.2)'; }}
          >
            <span style={{ fontSize: 14 }}>⊕</span>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 2 }}>Recoupement multi-sources</div>
              <div style={{ fontSize: 10, color: '#1a4a30', lineHeight: 1.4 }}>Croise 3-5 angles web · convergences, divergences, zones d'ombre</div>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

function SearchResultCard({ result, onClick }: { result: SearchHit; onClick: () => void }) {
  const meta     = KIND_META[result.kind as PageKind] ?? KIND_META.note;
  const scorePct = Math.round(result.score * 100);
  const scoreColor = scorePct > 74 ? '#3dffaa' : scorePct > 50 ? '#5ee7ff' : '#7a6c9a';

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display:    'block',
        width:      '100%',
        textAlign:  'left',
        padding:    '10px 14px',
        borderRadius: 9,
        border:     '1px solid rgba(61,255,170,0.07)',
        background: 'rgba(61,255,170,0.025)',
        cursor:     'pointer',
        transition: 'all 0.12s',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background    = 'rgba(61,255,170,0.06)';
        e.currentTarget.style.borderColor   = 'rgba(61,255,170,0.18)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background    = 'rgba(61,255,170,0.025)';
        e.currentTarget.style.borderColor   = 'rgba(61,255,170,0.07)';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ color: meta.color, fontSize: 14, flexShrink: 0 }}>{meta.icon}</span>
        <span className="font-grotesk font-semibold" style={{
          color: '#f0eaff', fontSize: 13, flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {result.title}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <div style={{ width: 44, height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
            <div style={{ width: `${scorePct}%`, height: '100%', borderRadius: 2, background: scoreColor, transition: 'width 0.3s' }} />
          </div>
          <span className="font-mono" style={{ fontSize: 10, color: scoreColor, minWidth: 26 }}>{scorePct}%</span>
        </div>
      </div>
      {result.content_preview && (
        <p className="font-mono" style={{ color: '#4a3a6a', fontSize: 11, lineHeight: 1.5, margin: 0 }}>
          {result.content_preview.slice(0, 130)}
        </p>
      )}
    </button>
  );
}

function CommandResultPanel({
  state, onNavigate, onPlayVideo, onClose, onClear,
}: {
  state:       NonNullable<CommandState>;
  onNavigate:  (id: string) => void;
  onPlayVideo: (videoId: string, title: string) => void;
  onClose:     () => void;
  onClear:     () => void;
}) {
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);

  const rowBase: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
    padding: '9px 14px', borderRadius: 8, border: 'none',
    cursor: 'pointer', textAlign: 'left', transition: 'background 0.12s',
    fontFamily: 'IBM Plex Mono, monospace', fontSize: 12,
    background: 'transparent', boxSizing: 'border-box',
  };

  if (state.type === 'lis') {
    return (
      <div style={{ margin: '16px 0', padding: '14px 16px', background: 'rgba(255,40,40,0.04)', border: '1px solid rgba(255,40,40,0.15)', borderRadius: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <p className="font-mono" style={{ color: '#ff6060', fontSize: 10, letterSpacing: '0.14em' }}>
            ▶ VIDÉOS — «&nbsp;{state.keywords}&nbsp;»
          </p>
          <button type="button" onClick={onClear} style={{ background: 'none', border: 'none', color: '#3d3060', cursor: 'pointer', padding: 2 }}>
            <X size={12} />
          </button>
        </div>

        {state.results.length === 0 ? (
          <p className="font-mono" style={{ color: '#4a3a6a', fontSize: 12 }}>
            Aucune vidéo YouTube trouvée pour ces mots-clés.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {state.results.map(({ page, videoId }) => (
              <button
                key={page.id}
                type="button"
                style={{ ...rowBase, background: 'rgba(255,40,40,0.06)', color: '#f0eaff' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,40,40,0.14)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,40,40,0.06)'; }}
                onClick={() => { onNavigate(page.id); onPlayVideo(videoId, page.title); onClose(); }}
              >
                <span style={{ background: '#ff0000', color: '#fff', borderRadius: '50%', width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, flexShrink: 0 }}>▶</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{page.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // state.type === 'ouvre'
  return (
    <div style={{ margin: '16px 0', padding: '14px 16px', background: 'rgba(94,231,255,0.04)', border: '1px solid rgba(94,231,255,0.15)', borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <p className="font-mono" style={{ color: '#5ee7ff', fontSize: 10, letterSpacing: '0.14em' }}>
          ↗ OUVRIR — «&nbsp;{state.arg}&nbsp;»
        </p>
        <button type="button" onClick={onClear} style={{ background: 'none', border: 'none', color: '#3d3060', cursor: 'pointer', padding: 2 }}>
          <X size={12} />
        </button>
      </div>

      {/* Pop-up bloqué (URL directe ou unique résultat) */}
      {(state.url ?? blockedUrl) && state.hits.length === 0 && (
        <div>
          <p className="font-mono" style={{ color: '#7a6c9a', fontSize: 11, marginBottom: 8 }}>
            Pop-up bloqué. Cliquez sur le lien :
          </p>
          <a
            href={state.url ?? blockedUrl ?? ''}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#5ee7ff', fontSize: 11, fontFamily: 'IBM Plex Mono, monospace', wordBreak: 'break-all' }}
          >
            {state.url ?? blockedUrl}
          </a>
        </div>
      )}

      {/* Aucun résultat */}
      {!state.url && !blockedUrl && state.hits.length === 0 && (
        <div>
          <p className="font-mono" style={{ color: '#4a3a6a', fontSize: 12 }}>
            Aucun raccourci ni neurone avec une URL source trouvé pour «&nbsp;{state.arg}&nbsp;».
          </p>
          {state.suggestion && state.suggestionUrl && (
            <button
              type="button"
              className="font-mono"
              onClick={() => {
                const win = window.open(state.suggestionUrl, '_blank', 'noopener,noreferrer');
                if (win) onClose();
              }}
              style={{
                marginTop: 8, fontSize: 11, color: '#5ee7ff', cursor: 'pointer',
                background: 'transparent', border: '1px solid rgba(94,231,255,0.25)', borderRadius: 6, padding: '5px 10px',
              }}
            >
              Vouliez-vous dire «&nbsp;{state.suggestion}&nbsp;» ?
            </button>
          )}
        </div>
      )}

      {/* Choix multiple */}
      {state.hits.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {blockedUrl && (
            <div style={{ marginBottom: 8, padding: '7px 12px', background: 'rgba(255,200,60,0.05)', border: '1px solid rgba(255,200,60,0.2)', borderRadius: 6 }}>
              <p className="font-mono" style={{ color: '#7a6c9a', fontSize: 11, marginBottom: 4 }}>Pop-up bloqué :</p>
              <a href={blockedUrl} target="_blank" rel="noopener noreferrer"
                style={{ color: '#5ee7ff', fontSize: 11, fontFamily: 'IBM Plex Mono, monospace', wordBreak: 'break-all' }}>
                {blockedUrl}
              </a>
            </div>
          )}
          {state.hits.map(({ page, sourceUrl }) => (
            <button
              key={page.id}
              type="button"
              style={{ ...rowBase, background: 'rgba(94,231,255,0.06)', color: '#f0eaff' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(94,231,255,0.14)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(94,231,255,0.06)'; }}
              onClick={() => {
                const win = window.open(sourceUrl, '_blank', 'noopener,noreferrer');
                if (win) { onClose(); } else { setBlockedUrl(sourceUrl); }
              }}
            >
              <span style={{ color: '#5ee7ff', fontSize: 13, flexShrink: 0 }}>↗</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{page.title}</div>
                <div style={{ fontSize: 10, color: '#3d6080', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{sourceUrl}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── ClarificationPanel ────────────────────────────────────────────────────────

function ClarificationPanel({
  state,
  onAnswer,
  onSkip,
}: {
  state:    ClarificationState;
  onAnswer: (a: ClarifyAnswer) => void;
  onSkip:   () => void;
}) {
  const [freeText, setFreeText] = useState('');
  const q    = state.questions[state.currentIdx];
  const total = state.questions.length;
  const idx   = state.currentIdx;

  if (!q) return null;

  function answer(text: string, isDefault = false) {
    setFreeText('');
    onAnswer({ question: q.text, answer: text, isDefault });
  }

  return (
    <div style={{
      margin:       '8px 0 12px',
      borderRadius:  10,
      border:       '1px solid rgba(61,255,170,0.15)',
      background:   'rgba(61,255,170,0.03)',
      overflow:     'hidden',
    }}>
      {/* Header */}
      <div style={{
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        padding:        '10px 14px 8px',
        borderBottom:   '1px solid rgba(61,255,170,0.08)',
        gap:             8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DocteurAvatar />
          <span className="font-mono" style={{ color: '#3dffaa', fontSize: 11 }}>
            Quelques précisions pour mieux te répondre
          </span>
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="font-mono"
          style={{
            fontSize:   10,
            padding:    '3px 10px',
            borderRadius: 5,
            border:     '1px solid rgba(255,255,255,0.08)',
            background: 'transparent',
            color:      '#4a3a6a',
            cursor:     'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Répondre directement ↗
        </button>
      </div>

      {/* Progress */}
      <div style={{ padding: '8px 14px 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="font-mono" style={{ fontSize: 9, color: '#3d3060', letterSpacing: '0.1em' }}>
          QUESTION {idx + 1} / {total}
        </span>
        <div style={{ flex: 1, height: 2, background: 'rgba(255,255,255,0.05)', borderRadius: 2 }}>
          <div style={{
            height: '100%',
            width:  `${((idx + 1) / total) * 100}%`,
            background:    '#3dffaa',
            borderRadius:   2,
            transition:    'width 0.3s ease',
          }} />
        </div>
      </div>

      {/* Question */}
      <div style={{ padding: '6px 14px 10px' }}>
        <p className="font-mono" style={{ color: '#d0c0f0', fontSize: 13, lineHeight: 1.6, margin: 0 }}>
          {q.text}
        </p>
      </div>

      {/* Predefined choices */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 14px 10px' }}>
        {q.choices.map((choice, ci) => (
          <button
            key={ci}
            type="button"
            onClick={() => answer(choice)}
            className="font-mono"
            style={{
              fontSize:     12,
              padding:      '7px 14px',
              borderRadius:  8,
              border:       '1px solid rgba(94,231,255,0.2)',
              background:   'rgba(94,231,255,0.04)',
              color:        '#5ee7ff',
              cursor:       'pointer',
              textAlign:    'left',
              lineHeight:   1.4,
              transition:   'all 0.13s',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(94,231,255,0.1)';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(94,231,255,0.4)';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(94,231,255,0.04)';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(94,231,255,0.2)';
            }}
          >
            {choice}
          </button>
        ))}
      </div>

      {/* Free text + decide for me */}
      <div style={{ padding: '0 14px 12px', display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={freeText}
          onChange={e => setFreeText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && freeText.trim()) answer(freeText.trim()); }}
          placeholder="Autre réponse…"
          className="font-mono"
          style={{
            flex:         1,
            fontSize:     12,
            padding:      '7px 10px',
            borderRadius:  8,
            border:       '1px solid rgba(255,255,255,0.08)',
            background:   'rgba(255,255,255,0.03)',
            color:        '#e0d8ff',
            outline:      'none',
            caretColor:   '#3dffaa',
          }}
        />
        <button
          type="button"
          disabled={!freeText.trim()}
          onClick={() => { if (freeText.trim()) answer(freeText.trim()); }}
          className="font-mono"
          style={{
            fontSize:     11,
            padding:      '7px 10px',
            borderRadius:  8,
            border:       '1px solid rgba(61,255,170,0.2)',
            background:   'rgba(61,255,170,0.06)',
            color:        '#3dffaa',
            cursor:       freeText.trim() ? 'pointer' : 'default',
            opacity:      freeText.trim() ? 1 : 0.4,
          }}
        >
          OK
        </button>
        <button
          type="button"
          onClick={() => answer('Décide pour moi', true)}
          title="L'IA choisira l'hypothèse la plus raisonnable"
          className="font-mono"
          style={{
            fontSize:     11,
            padding:      '7px 10px',
            borderRadius:  8,
            border:       '1px solid rgba(255,255,255,0.06)',
            background:   'transparent',
            color:        '#4a3a6a',
            cursor:       'pointer',
            whiteSpace:   'nowrap',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#8b7ab0'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#4a3a6a'; }}
        >
          Je ne sais pas
        </button>
      </div>
    </div>
  );
}

// ── ExplorePanel ──────────────────────────────────────────────────────────────

interface ExplorePanelProps {
  subject:  string;
  state:    ExploreState;
  onModeA:  () => void;
  onModeB:  () => void;
  onCancel: () => void;
  onSaveA?: () => Promise<void>;
  onSaveB?: () => Promise<void>;
}

function ExplorePanel({ subject, state, onModeA, onModeB, onCancel, onSaveA, onSaveB }: ExplorePanelProps) {
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);

  const isBusy    = state.phase === 'a-running' || state.phase === 'b-running';
  const isDoneA   = state.phase === 'b-done' && !!state.modeAResults;
  const isDoneB   = (state.phase === 'b-done' || state.phase === 'b-cancelled') && !!state.result;
  const isError   = state.phase === 'error';

  const BTN: React.CSSProperties = {
    flex: 1, display: 'flex', alignItems: 'flex-start', gap: 10,
    padding: '12px 14px', borderRadius: 9, border: 'none',
    cursor: 'pointer', textAlign: 'left', transition: 'all 0.13s',
    fontFamily: 'IBM Plex Mono, monospace',
  };

  async function save(fn: (() => Promise<void>) | undefined) {
    if (!fn || saving || saved) return;
    setSaving(true);
    try { await fn(); setSaved(true); } finally { setSaving(false); }
  }

  return (
    <div style={{
      margin: '16px 0', padding: '18px 20px',
      background: 'rgba(94,231,255,0.03)', border: '1px solid rgba(94,231,255,0.18)',
      borderRadius: 10,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <p className="font-mono" style={{ color: '#5ee7ff', fontSize: 10, letterSpacing: '0.14em', marginBottom: 4 }}>
            🔍 RECHERCHE WEB APPROFONDIE
          </p>
          <p className="font-grotesk font-semibold" style={{ color: '#f0eaff', fontSize: 13, maxWidth: 460 }}>
            {subject}
          </p>
        </div>
        {!isBusy && (
          <button type="button" onClick={onCancel} style={{ color: '#3d3060', cursor: 'pointer', padding: 2 }}>
            <X size={13} />
          </button>
        )}
      </div>

      {/* ── Choice ── */}
      {state.phase === 'choosing' && (
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="button"
            onClick={onModeA}
            style={{ ...BTN, background: 'rgba(94,231,255,0.05)', border: '1px solid rgba(94,231,255,0.18)', color: '#5ee7ff' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(94,231,255,0.12)'; e.currentTarget.style.borderColor = 'rgba(94,231,255,0.35)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(94,231,255,0.05)'; e.currentTarget.style.borderColor = 'rgba(94,231,255,0.18)'; }}
          >
            <Globe size={18} style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3 }}>Mode A — Liste brute</div>
              <div style={{ fontSize: 10, color: '#3d6080', lineHeight: 1.5 }}>15-25 résultats DuckDuckGo · zéro IA · liens cliquables dans un neurone</div>
            </div>
          </button>
          <button
            type="button"
            onClick={onModeB}
            style={{ ...BTN, background: 'rgba(61,255,170,0.04)', border: '1px solid rgba(61,255,170,0.18)', color: '#3dffaa' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(61,255,170,0.1)'; e.currentTarget.style.borderColor = 'rgba(61,255,170,0.35)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(61,255,170,0.04)'; e.currentTarget.style.borderColor = 'rgba(61,255,170,0.18)'; }}
          >
            <BookOpen size={18} style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3 }}>Mode B — Synthèse locale</div>
              <div style={{ fontSize: 10, color: '#1a5030', lineHeight: 1.5 }}>5-8 pages lues · synthèse par modèle local · aucun cloud · neurone structuré</div>
            </div>
          </button>
        </div>
      )}

      {/* ── Running ── */}
      {(state.phase === 'a-running' || state.phase === 'b-running') && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <div className="neural-dot" style={{ width: 5, height: 5 }} />
            <span className="font-mono" style={{ color: '#5a4a7a', fontSize: 12 }}>
              {state.msg || 'En cours…'}<ThinkingDots />
            </span>
          </div>

          {state.phase === 'b-running' && state.pages.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
              {state.pages.map((p, i) => (
                <div key={i} className="font-mono" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: p.ok ? '#3dffaa' : '#4a3a6a' }}>
                  <span>{p.ok ? '✓' : '✗'}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.domain}</span>
                </div>
              ))}
            </div>
          )}

          {state.phase === 'b-running' && (
            <button
              type="button"
              onClick={onCancel}
              className="font-mono"
              style={{
                fontSize: 11, padding: '6px 14px', borderRadius: 7,
                border: '1px solid rgba(255,77,88,0.3)', background: 'rgba(255,77,88,0.05)',
                color: '#ff4d58', cursor: 'pointer',
              }}
            >
              Annuler (conserver les résultats partiels)
            </button>
          )}
        </div>
      )}

      {/* ── Done Mode A ── */}
      {isDoneA && state.modeAResults && (
        <div>
          <p className="font-mono" style={{ color: '#3d6080', fontSize: 10, marginBottom: 8, letterSpacing: '0.08em' }}>
            {state.modeAResults.length} RÉSULTAT{state.modeAResults.length > 1 ? 'S' : ''} TROUVÉ{state.modeAResults.length > 1 ? 'S' : ''}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 240, overflowY: 'auto', marginBottom: 12 }}>
            {state.modeAResults.map((r, i) => (
              <a
                key={i}
                href={r.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono"
                style={{
                  display: 'block', padding: '7px 10px', borderRadius: 6,
                  border: '1px solid rgba(94,231,255,0.1)', background: 'rgba(94,231,255,0.03)',
                  textDecoration: 'none', transition: 'all 0.12s',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(94,231,255,0.08)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(94,231,255,0.03)'; }}
              >
                <div style={{ color: '#c8b8e8', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
                <div style={{ color: '#3d6080', fontSize: 10, marginTop: 2 }}>{r.domain}</div>
                {r.snippet && (
                  <div style={{ color: '#4a3a6a', fontSize: 10, marginTop: 2, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {r.snippet}
                  </div>
                )}
              </a>
            ))}
          </div>
          {onSaveA && (
            <SaveButton saved={saved} saving={saving} onSave={() => save(onSaveA)} />
          )}
        </div>
      )}

      {/* ── Done / Cancelled Mode B ── */}
      {isDoneB && state.result && (
        <div>
          {state.result.cancelled && (
            <p className="font-mono" style={{ color: '#f59e0b', fontSize: 10, marginBottom: 8 }}>
              ⚠ Annulé — synthèse partielle ({state.result.sources.filter(s => s.ok).length} page{state.result.sources.filter(s => s.ok).length > 1 ? 's' : ''} lue{state.result.sources.filter(s => s.ok).length > 1 ? 's' : ''})
            </p>
          )}
          <MarkdownContent
            text={state.result.content}
            textStyle={{ fontSize: 12, color: '#c8b8e8', lineHeight: 1.75, fontFamily: 'inherit' }}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 10, marginBottom: 10 }}>
            {state.result.sources.map((src, si) => (
              <a
                key={si}
                href={src.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono"
                style={{
                  fontSize: 10, padding: '2px 8px', borderRadius: 20,
                  border: `1px solid ${src.ok ? 'rgba(61,255,170,0.2)' : 'rgba(61,45,90,0.3)'}`,
                  background: src.ok ? 'rgba(61,255,170,0.05)' : 'transparent',
                  color: src.ok ? '#3dffaa' : '#4a3a6a',
                  textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 3,
                }}
              >
                <Globe size={8} /> {src.domain}
              </a>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <p className="font-mono" style={{ color: '#2e2555', fontSize: 9, flex: 1, letterSpacing: '0.06em' }}>
              {state.result.sources.filter(s => s.ok).length}/{state.result.sources.length} pages lues
              {state.result.modelUsed ? ` · ${state.result.modelUsed.split(':')[0]} · local` : ''}
              {state.result.latencyMs ? ` · ${(state.result.latencyMs / 1000).toFixed(1)}s` : ''}
            </p>
            {onSaveB && (
              <SaveButton saved={saved} saving={saving} onSave={() => save(onSaveB)} />
            )}
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {isError && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <p className="font-mono" style={{ color: '#ff4d58', fontSize: 12, flex: 1 }}>
            {state.error ?? 'Erreur inconnue'}
          </p>
          <button type="button" onClick={onCancel} className="font-mono"
            style={{ fontSize: 10, padding: '3px 10px', borderRadius: 6, border: '1px solid rgba(255,77,88,0.3)', background: 'transparent', color: '#ff4d58', cursor: 'pointer' }}>
            Fermer
          </button>
        </div>
      )}
    </div>
  );
}

interface CorpusSearchPanelProps {
  state:        CorpusSearchState;
  pages:        Page[];
  onToggle:     (url: string) => void;
  onSelectAll:  () => void;
  onSelectNone: () => void;
  onConfirm:    () => void;
  onCancel:     () => void;
  onRetry:      () => void;
}

function CorpusSearchPanel({ state, pages, onToggle, onSelectAll, onSelectNone, onConfirm, onCancel, onRetry }: CorpusSearchPanelProps) {
  const existingDomains = new Set(
    pages
      .map(p => { const u = p.metadata?.url; return typeof u === 'string' ? u : null; })
      .filter((u): u is string => !!u)
      .map(u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } })
      .filter((h): h is string => !!h),
  );

  const overLimit = state.selected.size > CORPUS_MAX_SELECT;

  return (
    <div style={{
      margin: '16px 0', padding: '18px 20px',
      background: 'rgba(132,204,22,0.03)', border: '1px solid rgba(132,204,22,0.18)',
      borderRadius: 10,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <p className="font-mono" style={{ color: '#84cc16', fontSize: 10, letterSpacing: '0.14em', marginBottom: 4 }}>
            <Mountain size={10} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
            CORPUS DE RÉFÉRENCE
          </p>
          <p className="font-grotesk font-semibold" style={{ color: '#f0eaff', fontSize: 13, maxWidth: 460 }}>
            {state.subject}
          </p>
        </div>
        {state.phase !== 'capturing' && (
          <button type="button" onClick={onCancel} style={{ color: '#3d3060', cursor: 'pointer', padding: 2 }}>
            <X size={13} />
          </button>
        )}
      </div>

      {/* ── Loading ── */}
      {state.phase === 'loading' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="neural-dot" style={{ width: 5, height: 5 }} />
          <span className="font-mono" style={{ color: '#5a4a7a', fontSize: 12 }}>Recherche DuckDuckGo…</span>
        </div>
      )}

      {/* ── Error ── */}
      {state.phase === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p className="font-mono" style={{ color: '#ff4d58', fontSize: 12 }}>{state.error ?? 'Erreur inconnue'}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onRetry} className="font-mono"
              style={{ fontSize: 10, padding: '3px 10px', borderRadius: 6, border: '1px solid rgba(94,231,255,0.3)', background: 'transparent', color: '#5ee7ff', cursor: 'pointer' }}>
              Réessayer
            </button>
            <button type="button" onClick={onCancel} className="font-mono"
              style={{ fontSize: 10, padding: '3px 10px', borderRadius: 6, border: '1px solid rgba(255,77,88,0.3)', background: 'transparent', color: '#ff4d58', cursor: 'pointer' }}>
              Fermer
            </button>
          </div>
        </div>
      )}

      {/* ── Results — checkbox selection ── */}
      {state.phase === 'results' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <p className="font-mono" style={{ color: '#5a8020', fontSize: 10, letterSpacing: '0.08em' }}>
              {state.results.length} RÉSULTAT{state.results.length > 1 ? 'S' : ''} · {state.selected.size} SÉLECTIONNÉ{state.selected.size > 1 ? 'S' : ''}
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={onSelectAll} className="font-mono" style={{ fontSize: 10, color: '#5ee7ff', cursor: 'pointer' }}>
                Tout sélectionner
              </button>
              <button type="button" onClick={onSelectNone} className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', cursor: 'pointer' }}>
                Tout désélectionner
              </button>
            </div>
          </div>

          {state.results.length === 0 ? (
            <p className="font-mono" style={{ color: '#4a3a6a', fontSize: 12 }}>Aucun résultat.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto', marginBottom: 12 }}>
              {state.results.map((r, i) => {
                const isDup = existingDomains.has(r.domain.replace(/^www\./, ''));
                const checked = state.selected.has(r.url);
                return (
                  <label
                    key={i}
                    className="font-mono"
                    style={{
                      display: 'flex', gap: 8, padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
                      border: `1px solid ${checked ? 'rgba(132,204,22,0.4)' : 'rgba(255,255,255,0.06)'}`,
                      background: checked ? 'rgba(132,204,22,0.07)' : 'rgba(255,255,255,0.02)',
                    }}
                  >
                    <input type="checkbox" checked={checked} onChange={() => onToggle(r.url)} style={{ marginTop: 3, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: '#c8b8e8', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                        <span style={{ color: '#5a8020', fontSize: 10 }}>{r.domain}</span>
                        {isDup && (
                          <span style={{ color: '#f59e0b', fontSize: 9, border: '1px solid rgba(245,158,11,0.3)', borderRadius: 10, padding: '0 5px' }}>
                            déjà dans le cortex
                          </span>
                        )}
                      </div>
                      {r.snippet && (
                        <div style={{ color: '#4a3a6a', fontSize: 10, marginTop: 2, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                          {r.snippet}
                        </div>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          {overLimit && (
            <p className="font-mono" style={{ color: '#ff4d58', fontSize: 11, marginBottom: 8 }}>
              {state.selected.size} sélectionnés — maximum {CORPUS_MAX_SELECT} par opération. Désélectionnez-en {state.selected.size - CORPUS_MAX_SELECT}.
            </p>
          )}

          <button
            type="button"
            disabled={state.selected.size === 0 || overLimit}
            onClick={onConfirm}
            className="font-mono"
            style={{
              fontSize: 11, padding: '7px 16px', borderRadius: 7, width: '100%',
              border: '1px solid rgba(132,204,22,0.35)',
              background: state.selected.size === 0 || overLimit ? 'rgba(132,204,22,0.04)' : 'rgba(132,204,22,0.12)',
              color: state.selected.size === 0 || overLimit ? '#4a5a2a' : '#84cc16',
              cursor: state.selected.size === 0 || overLimit ? 'default' : 'pointer',
            }}
          >
            Capturer {state.selected.size > 0 ? `${state.selected.size} page${state.selected.size > 1 ? 's' : ''}` : 'la sélection'}
          </button>
        </div>
      )}

      {/* ── Capturing ── */}
      {state.phase === 'capturing' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <div className="neural-dot" style={{ width: 5, height: 5 }} />
            <span className="font-mono" style={{ color: '#5a4a7a', fontSize: 12 }}>
              Capture en cours (extraction Readability, aucun résumé IA)…
            </span>
          </div>
          {state.progress && (
            <div style={{ height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                width: `${state.progress.total ? (state.progress.done / state.progress.total) * 100 : 0}%`,
                background: '#84cc16', transition: 'width 0.3s',
              }} />
            </div>
          )}
        </div>
      )}

      {/* ── Done — recap with per-page failures ── */}
      {state.phase === 'done' && state.summary && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <CheckCircle size={13} style={{ color: '#3dffaa', flexShrink: 0 }} />
            <p className="font-mono" style={{ color: '#c0e0a0', fontSize: 12 }}>
              {state.summary.ok}/{state.summary.total} pages capturées dans le corpus
            </p>
          </div>
          {state.summary.failures.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 140, overflowY: 'auto', padding: '8px 10px', borderRadius: 6, background: 'rgba(255,77,88,0.05)', border: '1px solid rgba(255,77,88,0.15)' }}>
              <p className="font-mono" style={{ color: '#ff8a90', fontSize: 10 }}>
                <AlertTriangle size={10} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
                {state.summary.failures.length} échec{state.summary.failures.length > 1 ? 's' : ''} :
              </p>
              {state.summary.failures.map((f, i) => (
                <p key={i} className="font-mono" style={{ color: '#c98a8e', fontSize: 10, lineHeight: 1.4 }}>
                  {f.name} — {f.error}
                </p>
              ))}
            </div>
          )}
          <button type="button" onClick={onCancel} className="font-mono"
            style={{ fontSize: 10, padding: '5px 12px', borderRadius: 6, border: '1px solid rgba(132,204,22,0.3)', background: 'transparent', color: '#84cc16', cursor: 'pointer', alignSelf: 'flex-start' }}>
            Fermer
          </button>
        </div>
      )}
    </div>
  );
}

function NoResults({ query, onCreatePage }: { query: string; onCreatePage: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '36px 0' }}>
      <p className="font-mono" style={{ color: '#4a3a6a', fontSize: 12, textAlign: 'center' }}>
        Je n'ai rien trouvé dans ton cortex pour «&nbsp;{query}&nbsp;».
      </p>
      <button
        type="button"
        onClick={onCreatePage}
        className="font-mono"
        style={{
          fontSize: 11, padding: '5px 14px', borderRadius: 6,
          border: '1px solid rgba(61,255,170,0.2)', background: 'transparent',
          color: '#3dffaa', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        <Plus size={11} />
        Créer un neurone sur ce sujet
      </button>
    </div>
  );
}
