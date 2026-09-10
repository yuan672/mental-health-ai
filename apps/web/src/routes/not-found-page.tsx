import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <main className="centered-state">
      <h1>页面不存在</h1>
      <Link className="button" to="/">
        返回首页
      </Link>
    </main>
  );
}
