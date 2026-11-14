import React, { createContext, useContext } from 'react';
import type { ProgramLandingData } from '../read-data/program-landing-data';

const ProgramLandingDataContext = createContext<ProgramLandingData | null>(null);

export function ProgramLandingDataProvider({ children, data }: { children: React.ReactNode; data: ProgramLandingData }) {
  return <ProgramLandingDataContext.Provider value={data}>{children}</ProgramLandingDataContext.Provider>;
}

export function useProgramLandingData(): ProgramLandingData {
  const data = useContext(ProgramLandingDataContext);
  if (!data) throw new Error('ProgramLanding must receive package-set DATA');
  return data;
}
