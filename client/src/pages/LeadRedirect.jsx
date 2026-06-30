import { useEffect, useState } from 'react';
import { useParams, useLocation, Navigate } from 'react-router-dom';
import { api } from '../utils/api';

// /leads/:id is retired as a user-facing page. Every inbound navigation to a
// per-call lead (lead cards, list rows, action-queue rows, schedule items, toasts,
// post-extraction redirects) now resolves to that lead's owning CUSTOMER and
// redirects to the customer profile (/customers/:cid). The off-profile call sites
// were left untouched — they still navigate('/leads/:id'); this shell does the
// resolve + redirect, so there is no per-call-site change to maintain.
//
// The resolver (GET /api/leads/:id/customer) is robust: it find-or-creates the
// customer even when leads.customer_id is still NULL (freshly-extracted, discarded,
// or deleted-customer leads), so no entry point can dead-end. We carry:
//   • ?call=<leadId> so the profile focuses the just-navigated call's engagement, and
//   • location.state (e.g. {fresh:true}) so the post-extraction "Lead extracted and
//     saved" confirmation still shows on the profile.
// Navigate uses `replace` so the back button skips this shell instead of bouncing.
//
// LeadDetailPage.jsx and its components remain in the codebase; this route simply
// no longer renders them to users.
export default function LeadRedirect() {
  const { id } = useParams();
  const location = useLocation();
  const [customerId, setCustomerId] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    setCustomerId(null);
    setError(null);
    api.getLeadCustomer(id)
      .then((res) => { if (active) setCustomerId(res?.customerId ?? null); })
      .catch((e) => { if (active) setError(e.message || 'Could not open this lead.'); });
    return () => { active = false; };
  }, [id]);

  if (customerId != null) {
    return (
      <Navigate
        to={`/customers/${customerId}?call=${encodeURIComponent(id)}`}
        replace
        state={location.state || undefined}
      />
    );
  }

  if (error) {
    return <div className="text-center py-12 text-muted text-sm">{error}</div>;
  }

  // Minimal spinner while resolving.
  return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin w-6 h-6 border-2 border-brand border-t-transparent rounded-full" />
    </div>
  );
}
