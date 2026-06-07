import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HotkeysProvider, ShortcutsModal, Omnibar, LookupModal, SequenceModal, useHotkeysContext } from 'use-kbd'
import 'use-kbd/styles.css'
import './index.css'
import App from './App.tsx'
import { ThemeProvider } from './ThemeContext'

// Swallow the recurring luma.gl 9.2.6 init-race noise:
//
//   TypeError: Cannot read properties of undefined (reading 'maxTextureDimension2D')
//     at WebGLCanvasContext.getMaxDrawingBufferSize
//     at WebGLCanvasContext._handleResize
//     at ResizeObserver.<anonymous>
//
// Triggered when ResizeObserver fires before `device.limits` is initialized.
// Subsequent resize ticks see `device.limits` set, so this is purely transient
// noise — the canvas always recovers on its own. Suppress just this one stack
// so the console stays usable; don't touch anything else.
window.addEventListener('error', (e) => {
  const msg = e.error?.message ?? e.message ?? ''
  const stack = e.error?.stack ?? ''
  if (msg.includes('maxTextureDimension2D') && stack.includes('getMaxDrawingBufferSize')) {
    e.preventDefault()
    e.stopImmediatePropagation()
  }
}, true)

function AppWithModals() {
  const { isModalOpen, closeModal } = useHotkeysContext()
  return (
    <>
      <App />
      <ShortcutsModal isOpen={isModalOpen} onClose={closeModal} editable />
      <Omnibar />
      <LookupModal />
      <SequenceModal />
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <HotkeysProvider>
        <AppWithModals />
      </HotkeysProvider>
    </ThemeProvider>
  </StrictMode>,
)
