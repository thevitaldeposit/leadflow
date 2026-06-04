import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import Layout from './components/Layout';
import DashboardPage from './pages/DashboardPage';
import NewLeadPage from './pages/NewLeadPage';
import LeadDetailPage from './pages/LeadDetailPage';
import LeadListPage from './pages/LeadListPage';
import SettingsPage from './pages/SettingsPage';
import InventoryPage from './pages/InventoryPage';
import FilteredLeadsPage from './pages/FilteredLeadsPage';
import SchedulePage from './pages/SchedulePage';
import AllLeadsPage from './pages/AllLeadsPage';
import StreamSignupsPage from './pages/StreamSignupsPage';
import LoginPage from './pages/LoginPage';
import LandingPage from './pages/LandingPage';
import SignupPage from './pages/SignupPage';
import { AuthProvider, useAuth } from './context/AuthContext';

// Pathless layout route: renders the dashboard chrome once and lets nested
// routes fill the <Outlet>. Keeps every authenticated page wrapped in Layout
// without repeating it per route.
function DashboardLayout() {
  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}

function AppRoutes() {
  const { loading, user } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-app-bg text-gray-500 text-sm">
        Loading…
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        {/* Public Stream lead-capture flow — always reachable, no dashboard chrome. */}
        <Route path="/signup" element={<SignupPage />} />

        {user ? (
          // Authenticated: the dashboard lives at its existing paths.
          <Route element={<DashboardLayout />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/new" element={<Navigate to="/new/transcript" replace />} />
            <Route path="/new/:type" element={<NewLeadPage />} />
            <Route path="/leads" element={<LeadListPage />} />
            <Route path="/leads/:id" element={<LeadDetailPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/action-queue" element={<FilteredLeadsPage mode="action_queue" />} />
            <Route path="/opportunities" element={<FilteredLeadsPage mode="opportunities" />} />
            <Route path="/booked" element={<FilteredLeadsPage mode="booked" />} />
            <Route path="/schedule" element={<SchedulePage />} />
            <Route path="/completed" element={<FilteredLeadsPage mode="completed" />} />
            <Route path="/all-leads" element={<AllLeadsPage />} />
            <Route path="/stream-signups" element={<StreamSignupsPage />} />
            {/* Unknown path (incl. /login while signed in) → dashboard home. */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        ) : (
          // Guest: public marketing site + login. Dashboard paths fall through
          // to the catch-all and are sent to the login screen.
          <>
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </>
        )}
      </Routes>
    </BrowserRouter>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
