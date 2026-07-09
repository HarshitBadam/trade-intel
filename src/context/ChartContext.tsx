"use client"

import React, { createContext, useContext, useState, ReactNode } from 'react';

interface ChartContextType {
  hoveredTimestamp: string | null;
  setHoveredTimestamp: (timestamp: string | null) => void;
}

const ChartContext = createContext<ChartContextType | undefined>(undefined);

export function ChartProvider({ children }: { children: ReactNode }) {
  const [hoveredTimestamp, setHoveredTimestamp] = useState<string | null>(null);

  return (
    <ChartContext.Provider value={{ hoveredTimestamp, setHoveredTimestamp }}>
      {children}
    </ChartContext.Provider>
  );
}

export function useChart() {
  const context = useContext(ChartContext);
  if (context === undefined) {
    throw new Error('useChart must be used within a ChartProvider');
  }
  return context;
} 