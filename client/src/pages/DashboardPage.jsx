import { useState } from 'react';
import Dashboard from '../components/Dashboard';
import VerticalTabs from '../components/VerticalTabs';
import HomeServicesDashboard from '../components/home_services/HomeServicesDashboard';
import SubscriptionBanner from '../components/SubscriptionBanner';
import { getActiveVertical, setActiveVertical } from '../utils/verticalConfig';

export default function DashboardPage() {
  const [vertical, setVertical] = useState(getActiveVertical());

  const handleTabChange = (id) => {
    setVertical(id);
    setActiveVertical(id);
  };

  return (
    <>
      <SubscriptionBanner />
      <VerticalTabs active={vertical} onChange={handleTabChange} />
      {vertical === 'home_services' ? <HomeServicesDashboard /> : <Dashboard />}
    </>
  );
}
