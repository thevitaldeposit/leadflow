import { useState } from 'react';
import LeadList from '../components/LeadList';
import VerticalTabs from '../components/VerticalTabs';
import HomeServicesLeadList from '../components/home_services/HomeServicesLeadList';
import { getActiveVertical, setActiveVertical } from '../utils/verticalConfig';

export default function LeadListPage() {
  const [vertical, setVertical] = useState(getActiveVertical());

  const handleTabChange = (id) => {
    setVertical(id);
    setActiveVertical(id);
  };

  return (
    <>
      <VerticalTabs active={vertical} onChange={handleTabChange} />
      {vertical === 'home_services' ? <HomeServicesLeadList /> : <LeadList />}
    </>
  );
}
