import type {
  KnowledgeArticleDetail,
  KnowledgeArticleSource,
  KnowledgeArticleSummary,
  KnowledgeContentBlock,
} from '@mental-health/types';

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

export function formatKnowledgeDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

export function KnowledgeStatus({
  article,
}: {
  article: Pick<KnowledgeArticleSummary, 'contentOrigin' | 'reviewStatus'>;
}) {
  if (article.contentOrigin === 'synthetic_fixture') {
    return <span className="knowledge-status knowledge-status-test">测试内容 · 未核验</span>;
  }
  return article.reviewStatus === 'source_verified' ? (
    <span className="knowledge-status knowledge-status-verified">来源已核对</span>
  ) : (
    <span className="knowledge-status">未核验</span>
  );
}

export function KnowledgeBlock({ block }: { block: KnowledgeContentBlock }) {
  if (block.type === 'heading') {
    return block.level === 2 ? <h2>{block.text}</h2> : <h3>{block.text}</h3>;
  }
  if (block.type === 'paragraph') return <p>{block.text}</p>;
  if (block.type === 'callout') {
    return (
      <aside className={`knowledge-callout knowledge-callout-${block.tone}`}>
        <strong>{block.tone === 'important' ? '请留意' : '提示'}</strong>
        <p>{block.text}</p>
      </aside>
    );
  }
  const List = block.style === 'ordered' ? 'ol' : 'ul';
  return (
    <List>
      {block.items.map((item, index) => (
        <li key={`${index}-${item}`}>{item}</li>
      ))}
    </List>
  );
}

export function KnowledgeSource({ source }: { source: KnowledgeArticleSource }) {
  return (
    <li className="knowledge-source">
      <h3>{source.sourceTitle}</h3>
      <dl>
        <div>
          <dt>发布者</dt>
          <dd>{source.publisherName}</dd>
        </div>
        {source.sourcePublishedAt ? (
          <div>
            <dt>来源日期</dt>
            <dd>{formatKnowledgeDate(source.sourcePublishedAt)}</dd>
          </div>
        ) : null}
        {source.sourceVersionLabel ? (
          <div>
            <dt>来源版本</dt>
            <dd>{source.sourceVersionLabel}</dd>
          </div>
        ) : null}
        {source.sourceLocator ? (
          <div>
            <dt>定位信息</dt>
            <dd>{source.sourceLocator}</dd>
          </div>
        ) : null}
        <div>
          <dt>检索时间</dt>
          <dd>{formatKnowledgeDate(source.retrievedAt)}</dd>
        </div>
      </dl>
      <a
        href={source.sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
      >
        打开外部来源（离开本站）
      </a>
    </li>
  );
}

export function KnowledgeEvidenceNote({ article }: { article: KnowledgeArticleDetail }) {
  return article.contentOrigin === 'synthetic_fixture' ? (
    <p className="knowledge-evidence-note">
      这是仅供 Development/Test 验证阅读流程的合成内容，不是正式发布或审核通过的健康资料。
    </p>
  ) : (
    <p className="knowledge-evidence-note">
      “来源已核对”表示记录的来源身份、版本和所支持内容经过核对；不表示专家医疗审核、临床验证或个体化医疗建议。
    </p>
  );
}
