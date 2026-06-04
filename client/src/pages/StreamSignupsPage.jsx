import { useEffect, useState } from 'react';
import { Radio } from 'lucide-react';
import { api } from '../utils/api';

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function StreamSignupsPage() {
  const [signups, setSignups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .getSignups()
      .then((data) => {
        setSignups(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return <div className="p-6 text-sm text-gray-400">Loading signups…</div>;
  }

  if (error) {
    return <div className="p-6 text-sm text-red-500">Error: {error}</div>;
  }

  const bookedCount = signups.filter((s) => s.call_booked).length;

  return (
    <div className="p-6">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
          <Radio size={18} />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Stream Signups</h2>
          <p className="text-sm text-gray-400">
            {signups.length} {signups.length === 1 ? 'prospect' : 'prospects'}
            {signups.length > 0 && ` · ${bookedCount} booked a call`}
          </p>
        </div>
      </div>

      {signups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-200 py-16 text-center text-sm text-gray-400">
          No signups yet. New prospects from the Stream landing page will appear here.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                {['Name', 'Business', 'Type', 'Phone', 'Email', 'Signed Up', 'Call Booked'].map((h) => (
                  <th
                    key={h}
                    className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {signups.map((s) => (
                <tr key={s.id} className="transition-colors hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-2.5 font-medium text-gray-800">
                    {s.first_name || '—'}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-gray-700">
                    {s.business_name || '—'}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5">
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                      {s.business_type || '—'}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-gray-600">
                    {s.phone ? (
                      <a href={`tel:${s.phone}`} className="hover:text-blue-600">
                        {s.phone}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-gray-600">
                    {s.email ? (
                      <a href={`mailto:${s.email}`} className="hover:text-blue-600">
                        {s.email}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-xs text-gray-400">
                    {formatDate(s.created_at)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5">
                    {s.call_booked ? (
                      <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                        Booked
                      </span>
                    ) : (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                        Not yet
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
