import type { KnowledgeArticleSummary } from '@mental-health/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { listKnowledgeArticles } from '../api/knowledge';
import { KnowledgeStatus, formatKnowledgeDate } from './knowledge-presentation';
import { CatArt } from '../shared/cat-art';
import { usePersonalSettings } from '../app/personal-settings';

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function KnowledgeListPage() {
  const personal = usePersonalSettings();
  const [query, setQuery] = useState(''),
    [onlySaved, setOnlySaved] = useState(false);
  const [articles, setArticles] = useState<KnowledgeArticleSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasLoadedFirstPage, setHasLoadedFirstPage] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async (cursor: string | null, mode: 'replace' | 'append') => {
    const controller = new AbortController();
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    controllerRef.current = controller;
    if (mode === 'append') setLoadingMore(true);
    else setLoading(true);
    if (mode === 'append') setPageError(null);
    else setError(null);
    try {
      const response = await listKnowledgeArticles(cursor, controller.signal);
      if (!mountedRef.current || controller.signal.aborted || generation !== generationRef.current)
        return;
      setArticles((current) => {
        if (mode === 'replace') return response.data.items;
        const existing = new Set(current.map((article) => article.articleKey));
        return [
          ...current,
          ...response.data.items.filter((article) => !existing.has(article.articleKey)),
        ];
      });
      if (mode === 'replace') setHasLoadedFirstPage(true);
      setNextCursor(response.data.nextCursor);
    } catch (reason) {
      if (!isAbortError(reason) && mountedRef.current && generation === generationRef.current) {
        if (mode === 'append') setPageError('无法加载更多内容，已显示的文章仍可阅读。');
        else setError('暂时无法读取知识内容，请稍后重试。');
      }
    } finally {
      if (mountedRef.current && generation === generationRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void Promise.resolve().then(() => load(null, 'replace'));
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [load]);

  const visibleArticles = articles.filter(
    (article) =>
      (!onlySaved || personal?.data?.bookmarks.includes(article.articleKey)) &&
      `${article.title} ${article.summary}`.includes(query.trim()),
  );
  return (
    <main className="knowledge-page" aria-labelledby="knowledge-title">
      <header className="knowledge-header">
        <CatArt mood="hopeful" />
        <p className="eyebrow">多了解一点自己</p>
        <h1 id="knowledge-title">知识中心</h1>
        <p>读一篇文章，给心里的疑问多一点理解。</p>
        <p className="knowledge-boundary">
          内容仅供一般教育与自我了解，不替代医疗诊断、治疗或紧急支持。
        </p>
      </header>
      <div className="knowledge-search">
        <label htmlFor="knowledge-search">搜索已加载文章</label>
        <input
          id="knowledge-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="试试标题里的关键词"
        />
        <button
          className="button button-secondary"
          aria-pressed={onlySaved}
          disabled={!personal?.data}
          onClick={() => setOnlySaved((v) => !v)}
        >
          {onlySaved ? '查看全部' : '只看收藏'}
        </button>
      </div>

      {loading ? <p aria-busy="true">正在加载知识内容…</p> : null}
      {error ? (
        <div className="knowledge-feedback" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void load(null, 'replace')}
          >
            重试
          </button>
        </div>
      ) : null}
      {hasLoadedFirstPage && !error && articles.length === 0 ? (
        <div className="knowledge-empty">
          <h2>当前没有可阅读的内容</h2>
          <p>目前还没有可阅读的文章，可以稍后重新加载。</p>
          <button
            type="button"
            className="button button-secondary"
            disabled={loading}
            onClick={() => void load(null, 'replace')}
          >
            {loading ? '正在重新加载…' : '重新加载'}
          </button>
        </div>
      ) : null}
      {articles.length > 0 ? (
        <ul className="knowledge-list" aria-label="知识文章">
          {visibleArticles.map((article) => (
            <li key={article.articleKey} className="knowledge-card">
              <div className="knowledge-card-meta">
                <KnowledgeStatus article={article} />
                <span>版本 {article.version}</span>
              </div>
              <h2>
                <Link to={`/app/knowledge/${encodeURIComponent(article.articleKey)}`}>
                  {article.title}
                </Link>
              </h2>
              <p>{article.summary}</p>
              <dl>
                <div>
                  <dt>发布日期</dt>
                  <dd>{formatKnowledgeDate(article.publishedAt)}</dd>
                </div>
                {article.reviewStatus === 'source_verified' && article.reviewedAt ? (
                  <div>
                    <dt>来源核验日期</dt>
                    <dd>{formatKnowledgeDate(article.reviewedAt)}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>来源发布者</dt>
                  <dd>{article.sourcePublishers.join('、')}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      ) : null}
      {!loading && articles.length > 0 && visibleArticles.length === 0 ? (
        <p className="knowledge-empty" role="status">
          已加载的文章中还没有匹配的内容。
          {nextCursor ? '可以继续加载更多，或换一个关键词。' : '可以换一个关键词，或查看全部文章。'}
        </p>
      ) : null}
      {pageError ? (
        <p className="inline-error" role="alert">
          {pageError}
        </p>
      ) : null}
      {nextCursor ? (
        <button
          type="button"
          className="button button-secondary knowledge-load-more"
          disabled={loadingMore}
          onClick={() => void load(nextCursor, 'append')}
        >
          {loadingMore ? '正在加载…' : '加载更多'}
        </button>
      ) : null}
    </main>
  );
}
