import { VERTICALS } from '../utils/verticalConfig';

export default function VerticalTabs({ active, onChange }) {
  return (
    <div className="border-b border-gray-200 mb-6">
      <div className="flex gap-1">
        {VERTICALS.map(v => {
          const isActive = v.id === active;
          return (
            <button
              key={v.id}
              onClick={() => onChange(v.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                isActive
                  ? 'border-accent text-accent'
                  : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'
              }`}
            >
              {v.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
