import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// The same UI is served both as a browser-action popup and as a standalone
// window. Only the window can be resized, so only it stretches to fill.
if (window.location.hash.startsWith('#detached')) {
  document.documentElement.classList.add('detached')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
