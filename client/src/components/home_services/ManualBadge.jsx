import { PencilLine } from 'lucide-react';

// Neutral gray badge marking leads created by hand (walk-in/text/email) rather
// than captured from a call, so the owner can tell them apart at a glance.
export default function ManualBadge({ size = 'sm' }) {
  const dims = size === 'md' ? 'text-xs px-2.5 py-1' : 'text-[10px] px-2 py-0.5';
  const icon = size === 'md' ? 12 : 10;
  return (
    <span className={`inline-flex items-center gap-1 font-semibold rounded-full border bg-gray-100 text-gray-600 border-gray-200 ${dims}`}>
      <PencilLine size={icon} />
      Manual
    </span>
  );
}
