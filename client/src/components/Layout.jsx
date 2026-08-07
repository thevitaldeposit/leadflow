import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  PlusCircle,
  Settings,
  FileText,
  ReceiptText,
  Image,
  Mic,
  PencilLine,
  Users,
  Calendar,
  Package,
  MapPin,
  DollarSign,
  Shield,
  CreditCard,
  Wallet,
  LogOut,
} from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import Navbar from './Navbar';
import { ToastContainer } from './Toast';
import socket from '../socket';
import { useAuth } from '../context/AuthContext';

const PAGE_TITLES = {
  '/': 'Dashboard',
  '/customers': 'Customers',
  '/pricing': 'Pricing',
  '/invoices': 'Invoices',
  '/invoices/new': 'New Invoice',
  '/payments': 'Payments',
  '/action-queue': 'Action Queue',
  '/opportunities': 'All Opportunities',
  '/booked': 'Booked Jobs',
  '/schedule': 'Schedule',
  '/insights': 'Insights',
  '/inventory': 'Inventory',
  '/dump-sites': 'Dump Sites',
  '/completed': 'Completed',
  '/leads': 'All Leads',
  '/all-leads': 'All Leads (Unfiltered)',
  '/new/manual': 'New Lead — Manual Entry',
  '/new/transcript': 'New Lead — Transcript',
  '/new/upsheet': 'New Lead — Up Sheet',
  '/new/audio': 'New Lead — Audio Recording',
  '/settings': 'Settings',
  '/billing': 'Billing',
  '/admin': 'Admin',
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

      const isMissedCall = lead.call_type === 'missed_call';
      const isAutoBooked = lead.auto_booked === 1;
      const smsSent = !!lead.payment_sms_sent_at;
      let toastTitle;
      if (isMissedCall) {
        // A missed call isn't a lead — surface it as a missed call the owner can
        // triage in the Action Queue, not as a captured lead.
        const caller = name || lead.phone || lead.caller_number || 'unknown number';
        toastTitle = `Missed call from ${caller}`;
        sub = 'No voicemail — review in the Action Queue';
      } else if (isAutoBooked) {
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
    ['/customers', '/pricing', '/invoices', '/payments', '/action-queue', '/opportunities', '/booked', '/schedule', '/inventory', '/dump-sites', '/completed'].some(p => location.pathname.startsWith(p));

  const linkClass = ({ isActive }) =>
    `flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
      isActive
        ? 'bg-sidebar-active text-content'
        : 'text-muted hover:bg-sidebar-hover hover:text-content'
    }`;

  return (
    <div className="flex h-screen w-full overflow-hidden">
      {/* Sidebar */}
      <aside className="w-60 flex-shrink-0 bg-sidebar flex flex-col">
        {/* Logo */}
        <div className="h-14 flex items-center px-5 border-b border-white/10">
          <img src="/assets/stream-logo-remove2.png" alt="Stream" style={{ width: '150px' }} />
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto scrollbar-thin">
          <NavLink to="/" end className={linkClass}>
            <LayoutDashboard size={18} />
            Dashboard
          </NavLink>

          {/* Home Services nav group */}
          <div className="pt-2 pb-1">
            <p className="px-4 text-[10px] font-bold text-muted uppercase tracking-widest mb-1">Home Services</p>
          </div>

          <NavLink to="/customers" className={linkClass}>
            <Users size={18} />
            Customers
          </NavLink>

          <NavLink to="/schedule" className={linkClass}>
            <Calendar size={18} />
            Schedule
          </NavLink>

          <NavLink to="/inventory" className={linkClass}>
            <Package size={18} />
            Inventory
          </NavLink>

          <NavLink to="/dump-sites" className={linkClass}>
            <MapPin size={18} />
            Dump Sites
          </NavLink>

          <NavLink to="/pricing" className={linkClass}>
            <DollarSign size={18} />
            Pricing
          </NavLink>

          <NavLink to="/invoices" className={linkClass}>
            <ReceiptText size={18} />
            Invoices
          </NavLink>

          <NavLink to="/payments" className={linkClass}>
            <Wallet size={18} />
            Payments
          </NavLink>

          <div className="pt-2 pb-1">
            <p className="px-4 text-[10px] font-bold text-muted uppercase tracking-widest mb-1">Tools</p>
          </div>

          {/* New Lead with sub-items */}
          <div>
            <button
              onClick={() => setNewOpen(v => !v)}
              className="w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium text-muted hover:bg-sidebar-hover hover:text-content transition-colors"
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

          {/* Admin panel — only the Stream/Valley Binz account (business 1). */}
          {business?.id === 1 && (
            <NavLink to="/admin" className={linkClass}>
              <Shield size={18} />
              Admin
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
            <p className="text-xs text-muted truncate" title={business.name}>{business.name}</p>
          )}
          <button
            onClick={logout}
            className="flex items-center gap-2 text-xs text-muted hover:text-content transition-colors"
          >
            <LogOut size={14} />
            Sign out
          </button>
          <p className="text-[10px] text-muted">Stream v1.0</p>
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
