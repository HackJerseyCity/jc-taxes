import { createContext, useContext } from 'react'
import type { ColorStop } from './gradient'

export type ThemeMode = 'dark' | 'light' | 'system'

export interface ThemeContextType {
  themeMode: ThemeMode
  actualTheme: 'light' | 'dark'
  toggleTheme: () => void
  colorStops: ColorStop[]
  hasCustomStops: boolean
  setColorStops: (stops: ColorStop[]) => void
  resetColorStops: () => void
}

export const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
