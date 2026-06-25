import { useParams, NavLink } from 'react-router-dom';
import { FileText, Image, Mic, PencilLine } from 'lucide-react';
import TranscriptInput from '../components/TranscriptInput';
import UpsheetUpload from '../components/UpsheetUpload';
import AudioUpload from '../components/AudioUpload';
import ManualLeadForm from '../components/ManualLeadForm';

export default function NewLeadPage() {
  const { type } = useParams();

  const tabClass = (t) =>
    `flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
      type === t
        ? 'bg-accent text-content shadow-sm'
        : 'text-muted hover:text-content hover:bg-surface-2'
    }`;

  return (
    <div className="space-y-5">
      {/* Tab switcher */}
      <div className="flex items-center gap-2 bg-surface rounded-xl border border-divider shadow-sm p-2 w-fit">
        <NavLink to="/new/manual" className={tabClass('manual')}>
          <PencilLine size={15} />
          Manual Entry
        </NavLink>
        <NavLink to="/new/transcript" className={tabClass('transcript')}>
          <FileText size={15} />
          Transcript
        </NavLink>
        <NavLink to="/new/upsheet" className={tabClass('upsheet')}>
          <Image size={15} />
          Up Sheet Photo
        </NavLink>
        <NavLink to="/new/audio" className={tabClass('audio')}>
          <Mic size={15} />
          Audio Recording
        </NavLink>
      </div>

      {type === 'manual' && <ManualLeadForm />}
      {type === 'transcript' && <TranscriptInput />}
      {type === 'upsheet' && <UpsheetUpload />}
      {type === 'audio' && <AudioUpload />}
    </div>
  );
}
