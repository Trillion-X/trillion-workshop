import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { decodeCatalogFeed } from './read-data/read-agent-catalog';
import { AgentCatalog } from './show/AgentCatalog';

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

export { AgentCatalog } from './show/AgentCatalog';
export { OrganizationalChart } from './show/OrganizationalChart';
export { decodeAgentRoleCatalogFeed } from './read-data/read-agent-role-catalog';
