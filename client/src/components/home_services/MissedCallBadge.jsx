// Badge marking a lead created from a missed call — an inbound call the owner
// didn't answer where the caller hung up without leaving a voicemail. Orange,
// to read as distinct from the purple Voicemail badge.
export default function MissedCallBadge({ size = 'sm' }) {
  const padding = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  return (
    <span className={`inline-flex items-center font-medium rounded-full border bg-warning/10 text-warning border-warning/30 ${padding}`}>
      Missed Call
    </span>
  );
}
