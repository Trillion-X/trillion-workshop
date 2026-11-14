import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { decodeCatalogFeed } from '@/packages/agent-catalog/read-data/read-agent-catalog';
import { AgentCatalog } from '@/packages/agent-catalog/show/AgentCatalog';

function AgentCatalogContents() {
  const catalogEntry = useBitfieldData();
  const catalog = React.useMemo(
    () => decodeCatalogFeed(catalogEntry),
    [catalogEntry],
  );

  return <AgentCatalog agents={catalog.agents} skills={catalog.skills} />;
}

export default function AgentCatalogPackage() {
  return <AgentCatalogContents />;
}

export { AgentCatalog } from '@/packages/agent-catalog/show/AgentCatalog';
export { OrganizationalChart } from '@/packages/agent-catalog/show/OrganizationalChart';
export { decodeAgentRoleCatalogFeed } from '@/packages/agent-catalog/read-data/read-agent-role-catalog';
