import { useLocation } from 'react-router';
import { CatArt } from './cat-art';
// Keep route content mounted so a visual transition never restarts a network request.
export function RouteCat() {
  const { pathname } = useLocation();
  const section = pathname.split('/').slice(0, 3).join('/');
  return (
    <div key={section} className="route-cat-curtain" aria-hidden="true">
      <div>
        <CatArt mood="happy" />
        <span>小猫陪你，慢慢来</span>
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
