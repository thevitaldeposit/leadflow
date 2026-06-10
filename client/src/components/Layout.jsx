import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  PlusCircle,
  Settings,
  FileText,
  Image,
  Mic,
  PencilLine,
  List,
  CalendarCheck2,
  Calendar,
  Package,
  CheckSquare,
  Database,
  Radio,
  CreditCard,
  LogOut,
} from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import Navbar from './Navbar';
import { ToastContainer } from './Toast';
import socket from '../socket';
import { useAuth } from '../context/AuthContext';

const PAGE_TITLES = {
  '/': 'Dashboard',
  '/action-queue': 'Action Queue',
  '/opportunities': 'All Opportunities',
  '/booked': 'Booked Jobs',
  '/schedule': 'Schedule',
  '/insights': 'Insights',
  '/inventory': 'Inventory',
  '/completed': 'Completed',
  '/leads': 'All Leads',
  '/all-leads': 'All Leads (Unfiltered)',
  '/new/manual': 'New Lead — Manual Entry',
  '/new/transcript': 'New Lead — Transcript',
  '/new/upsheet': 'New Lead — Up Sheet',
  '/new/audio': 'New Lead — Audio Recording',
  '/settings': 'Settings',
  '/billing': 'Billing',
};

let toastIdCounter = 0;

export default function Layout({ children }) {
  const location = useLocation();
  const { business, logout } = useAuth();
  const [newOpen, setNewOpen] = useState(false);
  const [toasts, setToasts] = useState([]);

  const title = PAGE_TITLES[location.pathname] || 'Lead Detail';

  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  useEffect(() => {
    const handleNewLead = (lead) => {
      let vd = {};
      if (lead.vertical_data) {
        try { vd = JSON.parse(lead.vertical_data); } catch { /* ignore */ }
      }
      const name = vd.customerName
        || [lead.customer_first_name, lead.customer_last_name].filter(Boolean).join(' ');

      let sub = null;
      if (lead.vertical === 'home_services') {
        sub = vd.dumpsterSize || vd.serviceType || vd.deliveryAddress || vd.propertyAddress || null;
      } else {
        sub = [lead.voi_make, lead.voi_model].filter(Boolean).join(' ') || null;
      }

      const isAutoBooked = lead.auto_booked === 1;
      const smsSent = !!lead.payment_sms_sent_at;
      let toastTitle;
      if (isAutoBooked) {
        const size = vd.dumpsterSize ? `${vd.dumpsterSize} dumpster` : 'dumpster';
        const date = lead.delivery_date ? `, delivery ${lead.delivery_date}` : '';
        toastTitle = smsSent
          ? `Job auto-booked & payment link sent to ${name || 'customer'}`
          : `Job auto-booked: ${name || 'Unknown'}`;
        sub = `${size}${date}`;
      } else {
        toastTitle = name ? `New lead: ${name}` : 'New lead captured';
      }

      const toast = { id: ++toastIdCounter, title: toastTitle, sub, leadId: lead.id, autoBooked: isAutoBooked };
      setToasts(prev => [...prev, toast]);
    };

    const handleSmsSent = ({ leadId, customerName, phone }) => {
      const displayName = customerName || 'customer';
      const displayPhone = phone || '';
      const toast = {
        id: ++toastIdCounter,
        title: `Payment link sent to ${displayName}`,
        sub: displayPhone,
        leadId,
        autoBooked: false,
      };
      setToasts(prev => [...prev, toast]);
    };

    socket.on('new_lead', handleNewLead);
    socket.on('payment_sms_sent', handleSmsSent);
    return () => {
      socket.off('new_lead', handleNewLead);
      socket.off('payment_sms_sent', handleSmsSent);
    };
  }, []);

  const isHomeServices = location.pathname === '/' ||
    ['/action-queue', '/opportunities', '/booked', '/schedule', '/inventory', '/completed'].some(p => location.pathname.startsWith(p));

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
          <div className="flex items-center gap-2.5">
            <svg
              width="28"
              height="28"
              viewBox="0 0 32 32"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M30 16 L23 3.88 L9 3.88 L2 16 L9 28.12 L23 28.12 Z"
                fill="#10b981"
                stroke="#10b981"
                strokeWidth="2.5"
                strokeLinejoin="round"
              />
              <path
                d="M21 10.5 C21 8, 11 8, 11 12 C11 15, 21 17, 21 20 C21 24, 11 24, 11 21.5"
                fill="none"
                stroke="#ffffff"
                strokeWidth="2.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-white font-extrabold text-xl tracking-tight">Stream</span>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto scrollbar-thin">
          <NavLink to="/" end className={linkClass}>
            <LayoutDashboard size={18} />
            Dashboard
          </NavLink>

          {/* Home Services nav group */}
          <div className="pt-2 pb-1">
            <p className="px-4 text-[10px] font-bold text-gray-600 uppercase tracking-widest mb-1">Home Services</p>
          </div>

          <NavLink to="/opportunities" className={linkClass}>
            <List size={18} />
            All Opportunities
          </NavLink>

          <NavLink to="/booked" className={linkClass}>
            <CalendarCheck2 size={18} />
            Booked Jobs
          </NavLink>

          <NavLink to="/schedule" className={linkClass}>
            <Calendar size={18} />
            Schedule
          </NavLink>

          <NavLink to="/inventory" className={linkClass}>
            <Package size={18} />
            Inventory
          </NavLink>

          <NavLink to="/completed" className={linkClass}>
            <CheckSquare size={18} />
            Completed
          </NavLink>

          <div className="pt-2 pb-1">
            <p className="px-4 text-[10px] font-bold text-gray-600 uppercase tracking-widest mb-1">Tools</p>
          </div>

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
                <NavLink to="/new/manual" className={linkClass}>
                  <PencilLine size={15} />
                  Manual Entry
                </NavLink>
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

          <NavLink to="/all-leads" className={linkClass}>
            <Database size={18} />
            All Leads
          </NavLink>

          {/* Stream admin — only the Stream/Valley Binz account (business 1). */}
          {business?.id === 1 && (
            <NavLink to="/stream-signups" className={linkClass}>
              <Radio size={18} />
              Stream Signups
            </NavLink>
          )}

          <NavLink to="/settings" className={linkClass}>
            <Settings size={18} />
            Settings
          </NavLink>

          <NavLink to="/billing" className={linkClass}>
            <CreditCard size={18} />
            Billing
          </NavLink>
        </nav>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-white/10 space-y-2">
          {business?.name && (
            <p className="text-xs text-gray-400 truncate" title={business.name}>{business.name}</p>
          )}
          <button
            onClick={logout}
            className="flex items-center gap-2 text-xs text-gray-500 hover:text-white transition-colors"
          >
            <LogOut size={14} />
            Sign out
          </button>
          <p className="text-[10px] text-gray-600">Stream v1.0</p>
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
