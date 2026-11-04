// Presentation reads the same context identity without loading account persistence.
import React from 'react'
import type { LayoutState } from '../read-data/layout-types'

export const LayoutStateContext = React.createContext<LayoutState | null>(null)
