import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../utils/api';

// Stubbed full insights page. For now it surfaces today's Morning Brief bullets
// and a placeholder for the richer reporting that will live here later.
export default function InsightsPage() {
  const [bullets, setBullets] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getMorningBrief()
      .then((data) => setBullets(Array.isArray(data?.bullets) ? data.bullets : []))
      .catch(() => setBullets([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Insights</h1>
        <p className="text-sm text-gray-500 mt-1">
          Your daily operational intelligence, powered by Stream.
        </p>
      </div>

      <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
          <Sparkles size={16} className="text-accent" />
          <h2 className="text-sm font-bold text-gray-900">Today's Brief</h2>
        </div>
        <div className="px-5 py-4">
          {loading ? (
            <p className="text-sm text-gray-400">Loading…</p>
          ) : bullets.length === 0 ? (
            <p className="text-sm text-gray-400">No insights available right now.</p>
          ) : (
            <ul className="space-y-2.5">
              {bullets.map((b, i) => (
                <li key={i} className="flex gap-2.5 text-sm text-gray-700">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="bg-white rounded-xl border border-gray-100 shadow-sm px-5 py-8 text-center">
        <p className="text-sm font-medium text-gray-500">More insights coming soon</p>
        <p className="text-xs text-gray-400 mt-1">
          Trends, conversion analytics, and revenue forecasting will appear here.
        </p>
      </section>
    </div>
  );
}
