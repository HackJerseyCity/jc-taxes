import { BrowserRouter, Routes, Route } from 'react-router-dom'
import MapView from './MapView'
import Home from './Home'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<MapView />} />
        <Route path="/about" element={<Home />} />
      </Routes>
    </BrowserRouter>
  )
}
