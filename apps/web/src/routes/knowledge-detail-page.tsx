import type { KnowledgeArticleDetail } from '@mental-health/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiClientError } from '../api/client';
import { getKnowledgeArticle } from '../api/knowledge';
import {
  KnowledgeBlock,
  KnowledgeEvidenceNote,
  KnowledgeSource,
  KnowledgeStatus,
  formatKnowledgeDate,
} from './knowledge-presentation';

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function KnowledgeDetailPage() {
  const { articleKey = '' } = useParams();
  const [article, setArticle] = useState<KnowledgeArticleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const controller = new AbortController();
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setLoading(true);
    setArticle(null);
    setNotFound(false);
    setError(null);
    try {
      const response = await getKnowledgeArticle(articleKey, controller.signal);
      if (!mountedRef.current || controller.signal.aborted || generation !== generationRef.current)
        return;
      setArticle(response.data.article);
    } catch (reason) {
      if (isAbortError(reason) || !mountedRef.current || generation !== generationRef.current)
        return;
      if (reason instanceof ApiClientError && reason.status === 404) setNotFound(true);
      else setError('暂时无法读取这篇内容，请稍后重试。');
    } finally {
      if (mountedRef.current && generation === generationRef.current) setLoading(false);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [articleKey]);

  useEffect(() => {
    mountedRef.current = true;
    void Promise.resolve().then(load);
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [load]);

  return (
    <main className="knowledge-page knowledge-detail-page" aria-label="知识文章">
      <Link className="knowledge-back-link" to="/app/knowledge">
        ← 返回知识中心
      </Link>
      {loading ? <p aria-busy="true">正在加载文章…</p> : null}
      {notFound ? (
        <section className="knowledge-empty">
          <h1 id="knowledge-detail-title">内容当前不可用</h1>
          <p>请返回知识中心查看当前可阅读的内容。</p>
          <Link className="button button-secondary" to="/app/knowledge">
            返回知识中心
          </Link>
        </section>
      ) : null}
      {error ? (
        <div className="knowledge-feedback" role="alert">
          <h1 id="knowledge-detail-title">暂时无法读取内容</h1>
          <p>{error}</p>
          <button type="button" className="button button-secondary" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}
      {article ? (
        <article className="knowledge-article">
          <header>
            <div className="knowledge-card-meta">
              <KnowledgeStatus article={article} />
              <span>版本 {article.version}</span>
            </div>
            <h1 id="knowledge-detail-title">{article.title}</h1>
            <p className="knowledge-summary">{article.summary}</p>
            <p className="muted">发布于 {formatKnowledgeDate(article.publishedAt)}</p>
          </header>
          <KnowledgeEvidenceNote article={article} />
          <div className="knowledge-body">
            {article.contentBlocks.map((block, index) => (
              <KnowledgeBlock key={index} block={block} />
            ))}
          </div>
          <section className="knowledge-sources" aria-labelledby="knowledge-sources-title">
            <h2 id="knowledge-sources-title">来源</h2>
            <ol>
              {article.sources.map((source, index) => (
                <KnowledgeSource key={`${index}-${source.sourceUrl}`} source={source} />
              ))}
            </ol>
          </section>
          <footer className="knowledge-boundary">
            本文用于一般教育与自我了解，不构成医疗诊断、治疗建议或紧急响应服务。
          </footer>
        </article>
      ) : null}
    </main>
  );
}
