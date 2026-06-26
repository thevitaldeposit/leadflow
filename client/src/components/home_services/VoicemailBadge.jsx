// Badge marking a lead that was captured from a voicemail message (vs. an
// answered or live-captured call). Rendered alongside the intent/urgency badges.
export default function VoicemailBadge({ size = 'sm', boxy = false }) {
  const padding = size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  const radius = boxy ? 'rounded-md' : 'rounded-full';
  // Purple — distinct from the blue brand color and the amber Missed Call badge.
  return (
    <span className={`inline-flex items-center font-medium border ${radius} bg-purple-500/10 text-purple-400 border-purple-500/30 ${padding}`}>
      Voicemail
    </span>
  );
}
