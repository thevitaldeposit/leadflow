import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  PlusCircle,
  List,
  Settings,
  FileText,
  Image,
  Mic,
  Zap,
} from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import Navbar from './Navbar';
import { ToastContainer } from './Toast';
import socket from '../socket';

const PAGE_TITLES = {
  '/': 'Dashboard',
  '/leads': 'All Leads',
  '/new/transcript': 'New Lead — Transcript',
  '/new/upsheet': 'New Lead — Up Sheet',
  '/new/audio': 'New Lead — Audio Recording',
  '/settings': 'Settings',
};

let toastIdCounter = 0;

export default function Layout({ children }) {
  const location = useLocation();
  const [newOpen, setNewOpen] = useState(false);
  const [toasts, setToasts] = useState([]);
  const title = PAGE_TITLES[location.pathname] || 'Lead Detail';

  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  useEffect(() => {
    const handleNewLead = (lead) => {
      const name = [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ');
      const voi = [lead.voi_make, lead.voi_model].filter(Boolean).join(' ');

      const toast = {
        id: ++toastIdCounter,
        title: name ? `New lead: ${name}` : 'New lead captured',
        sub: voi || null,
        leadId: lead.id,
      };
      setToasts(prev => [...prev, toast]);
    };

    socket.on('new_lead', handleNewLead);
    return () => socket.off('new_lead', handleNewLead);
  }, []);

  const linkClass = ({ isActive }) =>
    `flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
      isActive
        ? 'bg-sidebar-active text-white'
        : 'text-gray-400 hover:bg-sidebar-hover hover:text-white'
    }`;

  return (
    <div className="flex h-screen w-full overflow-hidden">
      {/* Sidebar */}
      <aside className="w-60 flex-shrink-0 bg-sidebar flex flex-col">
        {/* Logo */}
        <div className="h-14 flex items-center px-5 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Zap size={20} className="text-accent" />
            <span className="text-white font-bold text-lg tracking-tight">LeadFlow</span>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto scrollbar-thin">
          <NavLink to="/" end className={linkClass}>
            <LayoutDashboard size={18} />
            Dashboard
          </NavLink>

          {/* New Lead with sub-items */}
          <div>
            <button
              onClick={() => setNewOpen(v => !v)}
              className="w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium text-gray-400 hover:bg-sidebar-hover hover:text-white transition-colors"
            >
              <PlusCircle size={18} />
              <span className="flex-1 text-left">New Lead</span>
              <span className={`text-xs transition-transform ${newOpen ? 'rotate-90' : ''}`}>›</span>
            </button>
            {newOpen && (
              <div className="ml-6 mt-1 space-y-0.5">
                <NavLink to="/new/transcript" className={linkClass}>
                  <FileText size={15} />
                  Transcript
                </NavLink>
                <NavLink to="/new/upsheet" className={linkClass}>
                  <Image size={15} />
                  Up Sheet
                </NavLink>
                <NavLink to="/new/audio" className={linkClass}>
                  <Mic size={15} />
                  Audio Recording
                </NavLink>
              </div>
            )}
          </div>

          <NavLink to="/leads" className={linkClass}>
            <List size={18} />
            All Leads
          </NavLink>

          <NavLink to="/settings" className={linkClass}>
            <Settings size={18} />
            Settings
          </NavLink>
        </nav>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-white/10">
          <p className="text-xs text-gray-500">LeadFlow v1.0</p>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Navbar title={title} />
        <main className="flex-1 overflow-y-auto p-6 bg-app-bg">
          {children}
        </main>
      </div>

      {/* Toast notifications */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
