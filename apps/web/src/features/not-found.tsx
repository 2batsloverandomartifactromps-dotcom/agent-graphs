import { Link } from '@tanstack/react-router';
import { Empty } from '../components/ui';

export function NotFound() {
  return (
    <section className="view on page">
      <Empty title="Page not found">
        <Link to="/" className="link">
          Back to the overview
        </Link>
      </Empty>
    </section>
  );
}
