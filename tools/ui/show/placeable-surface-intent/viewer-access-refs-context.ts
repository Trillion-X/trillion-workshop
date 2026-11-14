import React from 'react';

/** Shared opaque held-ref context consumed by presentation owners. */
export const ViewerAccessRefsContext = React.createContext<readonly string[] | undefined>(undefined);
