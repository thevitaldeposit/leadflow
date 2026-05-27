import { Bell, Search } from 'lucide-react';

export default function Navbar({ title }) {
  return (
    <header className="h-14 bg-white border-b border-gray-200 flex items-center px-6 gap-4 flex-shrink-0">
      <h1 className="text-lg font-semibold text-gray-800 flex-1">{title}</h1>
      <div className="flex items-center gap-3">
        <button className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500">
          <Bell size={18} />
        </button>
        <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-white text-sm font-semibold">
          M
        </div>
      </div>
    </header>
  );
}
