import type { KnowledgeReference } from '@mental-health/types';
import { Icon } from '../../shared/icons';

export function KnowledgeReferences({ references }: { references: KnowledgeReference[] }) {
  if (references.length === 0) return null;
  return (
    <aside className="message-references" aria-label="本次回答参考的知识来源">
      <h3>
        <Icon name="book-open" /> 参考内容
      </h3>
      <p>以下引用对应整段回答，不表示每一句话都由单一来源直接支持。</p>
      <ol>
        {references.map((reference) => (
          <li key={`${reference.articleKey}:${reference.version}`}>
            <div className="reference-heading">
              <strong>{reference.title}</strong>
              <span>版本 {reference.version}</span>
            </div>
            <p>
              {reference.contentOrigin === 'synthetic_fixture' ? '测试内容 · 未核验' : '来源已核对'}
              {reference.availability === 'no_longer_available' ? ' · 当前版本不可用' : ''}
            </p>
            <ul>
              {reference.sources.map((source) => (
                <li key={source.ordinal}>
                  {source.linkState === 'available' ? (
                    <a
                      href={source.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      referrerPolicy="no-referrer"
                    >
                      {source.publisherName}：{source.sourceTitle}（离开本站）
                    </a>
                  ) : (
                    <span>
                      {source.publisherName}：{source.sourceTitle}（链接当前不可用）
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </aside>
  );
}
