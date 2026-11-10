import { useState } from 'react';
import { Link } from 'react-router';
import windowNook from '../../assets/cozy/window-nook.png';
import cat from '../../assets/cozy/companion-cat-alpha.png';
import { CozyIcon } from '../../shared/cozy-icon';
export function ChatCompanion() {
  const [petted, setPetted] = useState(false);
  return (
    <aside className="chat-companion">
      <div className="nook-window">
        <img src={windowNook} alt="窗边静静洒进来的阳光" />
      </div>
      <h2>这里，留一点空隙。</h2>
      <p>
        不必急着找到答案，
        <br />
        也不用把每句话说完整。
      </p>
      <button
        className={`pet-cat ${petted ? 'petted' : ''}`}
        onPointerEnter={() => setPetted(true)}
        onPointerLeave={() => setPetted(false)}
        onClick={() => setPetted((v) => !v)}
        aria-label="摸摸陪伴小猫"
      >
        <img src={cat} alt="" />
        <span aria-hidden="true">♡</span>
      </button>
      <p className="pet-caption">
        {petted ? '呼噜呼噜，陪你待一会儿。' : '想停一会儿，就摸摸小猫。'}
      </p>
      <Link className="text-button" to="/app/diary">
        想写下来？去日记本 <CozyIcon name="arrow" />
      </Link>
    </aside>
  );
}
