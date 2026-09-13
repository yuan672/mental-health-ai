import { Link } from 'react-router';
import cozyBrand from '../assets/cozy-brand.png';
import cozyHero from '../assets/cozy-hero.png';
import { copy } from '../locales';
import { CatArt } from '../shared/cat-art';
import { Icon } from '../shared/icons';

export function LandingPage() {
  return (
    <main className="landing design-landing">
      <header className="landing-header">
        <Link className="landing-brand" to="/">
          <img src={cozyBrand} alt="" aria-hidden="true" />
          <span>
            <strong>{copy.app.shortName}</strong>
            <small>安心支持 · 温暖陪伴</small>
          </span>
        </Link>
        <nav aria-label="账号入口">
          <Link className="text-link" to="/login">
            登录
          </Link>
          <Link className="button button-secondary" to="/register">
            注册
          </Link>
        </nav>
      </header>
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-copy">
          <p className="eyebrow">给情绪留一点空间</p>
          <h1 id="landing-title">今天，也可以慢慢来。</h1>
          <p className="landing-lead">
            一个面向 18
            岁及以上成年用户的日常心理支持空间。写下感受，记录心情，也读一点帮助理解自己的知识。
          </p>
          <div className="landing-actions">
            <Link className="button" to="/login">
              进入安心支持 <Icon name="arrow-right" />
            </Link>
            <Link className="text-link" to="/register">
              查看注册
            </Link>
          </div>
          <p className="landing-soft-note">
            <Icon name="heart" /> 你的感受值得被认真听见。
          </p>
        </div>
        <div className="landing-art" aria-hidden="true">
          <img src={cozyHero} alt="" />
          <CatArt mood="relaxed" />
        </div>
      </section>
      <section className="landing-features" aria-label="可以做什么">
        <article>
          <CatArt mood="happy" />
          <h2>聊一聊</h2>
          <p>按自己的节奏表达感受，获得一般性的支持。</p>
        </article>
        <article>
          <CatArt mood="shy" />
          <h2>记下心情</h2>
          <p>用简单记录回看最近七天或三十天的变化。</p>
        </article>
        <article>
          <CatArt mood="sleepy" />
          <h2>读一点知识</h2>
          <p>阅读带有版本和来源说明的心理健康教育内容。</p>
        </article>
      </section>
      <section className="boundary-note">
        <Icon name="shield" />
        <div>
          <h2>温暖陪伴，也有清楚边界</h2>
          <p>本产品不提供医疗诊断、处方、真人咨询或紧急响应，也不能替代现实中的专业帮助。</p>
        </div>
      </section>
    </main>
  );
}
