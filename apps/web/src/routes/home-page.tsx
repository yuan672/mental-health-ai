import { Link } from 'react-router';
import cozyDiary from '../assets/cozy-diary.png';
import cozyHero from '../assets/cozy-hero.png';
import { useProductData } from '../app/product-data-provider';
import { CatArt } from '../shared/cat-art';
import { Icon } from '../shared/icons';

export function HomePage() {
  const product = useProductData();

  return (
    <main className="home-page" aria-labelledby="home-title">
      <header className="home-heading">
        <h1 id="home-title">今天，也值得被温柔对待。</h1>
        <p>不用急着整理好心情，先在这里歇一会儿。</p>
      </header>

      <div className="home-grid">
        <section className="home-hero" aria-labelledby="home-chat-title">
          <div className="home-hero-copy">
            <h2 id="home-chat-title">想说的话，慢慢说。</h2>
            <p>开心的、烦恼的，或是不知道从哪里说起的，都可以从这一刻开始。</p>
            <Link className="button" to="/app/chat">
              聊一聊 <Icon name="arrow-right" />
            </Link>
          </div>
          <img src={cozyHero} alt="" aria-hidden="true" />
          <p className="home-hero-note">
            <Icon name="heart" /> 按你的节奏，我在这里。
          </p>
        </section>

        <div className="home-side-cards">
          <section className="home-mood-card" aria-labelledby="home-mood-title">
            <h2 id="home-mood-title">此刻，你感觉怎么样？</h2>
            <p>选一只最像现在的你的小猫。</p>
            <div className="home-cat-row" aria-hidden="true">
              <CatArt mood="happy" />
              <CatArt mood="sad" />
              <CatArt mood="relaxed" />
            </div>
            <Link className="text-link" to="/app/mood">
              记录此刻的心情 <Icon name="arrow-right" />
            </Link>
          </section>

          <section className="home-knowledge-card" aria-labelledby="home-knowledge-title">
            <div>
              <h2 id="home-knowledge-title">给今天留一点空间</h2>
              <p>读一小段经过整理的知识，也许会多一点理解自己的角度。</p>
              <Link className="button button-secondary" to="/app/knowledge">
                去知识中心
              </Link>
            </div>
            <img src={cozyDiary} alt="" aria-hidden="true" />
          </section>
        </div>
      </div>

      <footer className="home-footer-note">
        <Icon name="heart" />
        <span>
          {product.capabilities?.aiChatEnabled === false
            ? 'AI 对话当前未开放，心情记录与知识阅读仍可使用。'
            : '一点心情、一件小事，都值得被记住。'}
        </span>
      </footer>
    </main>
  );
}
