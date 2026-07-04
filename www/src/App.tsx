import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import MapView from './MapView'

// Lazy so the landing page + Plotly bundle stay off the map (`/`) route.
const Home = lazy(() => import('./Home'))

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<MapView />} />
        <Route path="/about" element={<Suspense fallback={null}><Home /></Suspense>} />
      </Routes>
    </BrowserRouter>
  )
}
