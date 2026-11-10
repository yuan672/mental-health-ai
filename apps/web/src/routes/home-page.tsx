import { Link } from 'react-router';
import { usePersonalSettings } from '../app/personal-settings';
import { CatArt, homeCat, diaryCat } from '../shared/cat-art';
import { CozyIcon, type IconName } from '../shared/cozy-icon';

export function HomePage() {
  const settings = usePersonalSettings();
  const name = settings?.data?.displayName;
  return (
    <main className="home-page">
      <header className="cozy-page-heading">
        <div>
          <p className="eyebrow">给自己一点时间</p>
          <h1>{name ? `${name}，欢迎回来。` : '今天，也好好照顾自己。'}</h1>
          <p>不必急着变好。坐一会儿，从你想做的小事开始。</p>
        </div>
        <CatArt mood={settings?.data?.cat ?? 'relaxed'} />
      </header>
      <div className="home-grid">
        <section className="home-main-card">
          <div>
            <span className="eyebrow">小猫在这里</span>
            <h2>
              想说的话，
              <br />
              慢慢说就好。
            </h2>
            <p>
              一点心情，一件小事，
              <br />
              都可以成为今天的开场。
            </p>
            <Link className="button" to="/app/chat">
              去聊一聊 <CozyIcon name="arrow" />
            </Link>
          </div>
          <img src={homeCat} alt="温暖的房间里，小猫安静地陪着你" />
        </section>
        <section className="home-diary-card">
          <img src={diaryCat} alt="趴在日记本旁的小猫" />
          <h2>今天，值得被记住。</h2>
          <p>打开一本日记，留下一点今天的痕迹。</p>
          <Link className="text-button" to="/app/diary">
            打开我的书架 <CozyIcon name="arrow" />
          </Link>
        </section>
        <section className="home-quick" aria-label="从一件小事开始">
          {(
            [
              {
                to: 'mood',
                icon: 'smile',
                title: '看看此刻的心情',
                text: '用一只小猫，记录当下的感受。',
              },
              {
                to: 'knowledge',
                icon: 'read',
                title: '多了解一点自己',
                text: '找一篇文章，按自己的节奏读。',
              },
              {
                to: 'privacy',
                icon: 'shield',
                title: '安心，由自己掌握',
                text: '查看授权与数据设置。',
              },
            ] as { to: string; icon: IconName; title: string; text: string }[]
          ).map((item) => (
            <Link key={item.to} to={`/app/${item.to}`}>
              <CozyIcon name={item.icon} />
              <div>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </div>
              <CozyIcon name="arrow" />
            </Link>
          ))}
        </section>
      </div>
    </main>
  );
}
