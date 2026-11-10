import { Link } from 'react-router';
import { copy } from '../locales';
import { brandCat, homeCat } from '../shared/cat-art';

export function LandingPage() {
  return (
    <main className="landing">
      <header className="landing-header">
        <img className="brand-cat" src={brandCat} alt="" />
        <span>{copy.app.name}</span>
      </header>
      <section className="landing-hero" aria-labelledby="landing-title">
        <img
          className="landing-cat-art"
          src={homeCat}
          alt="小猫在温暖的房间里，留一个位置陪你坐坐"
        />
        <p className="eyebrow">为情绪表达留一点空间</p>
        <h1 id="landing-title">在这里，慢慢说也可以。</h1>
        <p className="landing-lead">
          面向中国大陆 18
          岁及以上成年用户的日常心理支持工具，帮助你表达感受、梳理压力并获得一般性支持。
        </p>
        <div className="landing-actions">
          <Link className="button" to="/login">
            登录
          </Link>
          <Link className="button button-secondary" to="/register">
            注册
          </Link>
        </div>
        <div className="boundary-note">
          <h2>使用边界</h2>
          <p>本产品不提供医疗诊断、处方或真人咨询，也不替代现实中的专业帮助或紧急服务。</p>
          <p>聊天内容和必要安全记录遵循不同的数据生命周期；具体说明将在相关产品页面中清晰展示。</p>
        </div>
      </section>
    </main>
  );
}
