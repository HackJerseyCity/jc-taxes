import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import MapView from './MapView'
import Home from './Home'

// Map-page URL params. If `/` is loaded with ANY of these in the query string,
// we redirect to `/map` preserving the query — so pre-rework deep links
// (`jct.rbw.sh/?v=…&agg=lot&y=2025`) keep landing on the map experience.
const MAP_PARAMS = new Set([
  '3d', 'agg', 'animYr', 'cb', 'metric', 'mh', 'pct', 'scale',
  'sel', 'so', 'sp', 'ti', 'v', 'wg', 'wl', 'y',
])

function HomeOrRedirect() {
  const { search } = useLocation()
  const params = new URLSearchParams(search)
  for (const k of params.keys()) {
    if (MAP_PARAMS.has(k)) return <Navigate to={{ pathname: '/map', search }} replace />
  }
  return <Home />
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomeOrRedirect />} />
        <Route path="/map" element={<MapView />} />
      </Routes>
    </BrowserRouter>
  )
}
