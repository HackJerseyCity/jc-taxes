import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HotkeysProvider, ShortcutsModal, Omnibar, LookupModal, SequenceModal, useHotkeysContext } from 'use-kbd'
import 'use-kbd/styles.css'
import './index.css'
import App from './App.tsx'
import { ThemeProvider } from './ThemeContext'

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
