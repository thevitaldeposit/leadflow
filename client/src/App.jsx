import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
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
import LoginPage from './pages/LoginPage';
import { AuthProvider, useAuth } from './context/AuthContext';

function AppRoutes() {
  const { loading, user } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-app-bg text-gray-500 text-sm">
        Loading…
      </div>
    );
  }

  if (!user) return <LoginPage />;

  return (
    <BrowserRouter>
      <Layout>
        <Routes>
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
        </Routes>
      </Layout>
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
