import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useUrlState } from 'use-prms'
import {
  type ColorStop,
  DEFAULT_STOPS_DARK,
  DEFAULT_STOPS_LIGHT,
  decodeStops,
  encodeStops,
} from './gradient'
import { ThemeContext, type ThemeMode } from './theme'

const STORAGE_KEY = 'jc-taxes-theme'
const MODES: ThemeMode[] = ['dark', 'light', 'system']

function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return mode
}

function loadMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'dark' || stored === 'light' || stored === 'system') return stored
  return 'dark'
}

type ThemeStops = {
  light: boolean
  stops: ColorStop[] | null
}

const cParam = {
  decode: (s: string | undefined): ThemeStops => {
    if (!s) return { light: false, stops: null }
    if (s.startsWith('l')) {
      const rest = s.slice(1)
      return { light: true, stops: rest ? decodeStops(rest) : null }
    }
    return { light: false, stops: decodeStops(s) }
  },
  encode: (v: ThemeStops): string | undefined => {
    if (!v.light && !v.stops) return undefined
    const stopsStr = v.stops ? encodeStops(v.stops) : ''
    return v.light ? 'l' + stopsStr : stopsStr
  },
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [{ stops: customStops }, setThemeStops] = useUrlState('c', cParam)
  const [themeMode, setThemeMode] = useState<ThemeMode>(loadMode)
  const [systemTheme, setSystemTheme] = useState<'dark' | 'light'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  )

  // Listen for OS theme changes
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? 'dark' : 'light')
    }
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  const actualTheme = useMemo<'dark' | 'light'>(
    () => themeMode === 'system' ? systemTheme : themeMode,
    [themeMode, systemTheme],
  )

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', actualTheme)
    // Also drive `color-scheme` so components that lean on system/semantic
    // colors (e.g. the @rdub/file-tree table on /files) follow the app theme
    // instead of defaulting to light.
    document.documentElement.style.colorScheme = actualTheme
  }, [actualTheme])

  const light = actualTheme === 'light'
  const colorStops = customStops ?? (light ? DEFAULT_STOPS_LIGHT : DEFAULT_STOPS_DARK)

  const toggleTheme = useCallback(() => {
    const curIdx = MODES.indexOf(themeMode)
    const nextMode = MODES[(curIdx + 1) % MODES.length]
    const nextTheme = resolveTheme(nextMode)
    const nextLight = nextTheme === 'light'
    // Save current custom stops for current theme
    if (customStops) {
      localStorage.setItem(`jc-taxes-stops-${actualTheme}`, encodeStops(customStops))
    }
    // Load other theme's custom stops from localStorage
    const saved = localStorage.getItem(`jc-taxes-stops-${nextTheme}`)
    const nextStops = saved ? decodeStops(saved) : null
    setThemeStops({ light: nextLight, stops: nextStops })
    setThemeMode(nextMode)
    localStorage.setItem(STORAGE_KEY, nextMode)
  }, [themeMode, customStops, actualTheme, setThemeStops])

  const setColorStops = useCallback((stops: ColorStop[]) => {
    setThemeStops({ light, stops })
  }, [light, setThemeStops])

  const resetColorStops = useCallback(() => {
    localStorage.removeItem(`jc-taxes-stops-${actualTheme}`)
    setThemeStops({ light, stops: null })
  }, [light, actualTheme, setThemeStops])

  return (
    <ThemeContext.Provider value={{ themeMode, actualTheme, toggleTheme, colorStops, hasCustomStops: customStops !== null, setColorStops, resetColorStops }}>
      {children}
    </ThemeContext.Provider>
  )
}
