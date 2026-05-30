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

export default function App() {
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
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
