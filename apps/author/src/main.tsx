// Applies the tab-scoped drawer state before React mounts. It must stay the
// first side-effect import, and it must not be inline in index.html: the Worker
// CSP is `script-src 'self'` (review P1-1).
import './boot.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@selfpage/design-tokens/tokens.css';
// The public site's exact shell stylesheet (see apps/site/src/layouts/BaseLayout.astro):
// top bar, 19.4% drawer, navigation hierarchy, narrow overlay (D29).
import '@selfpage/site-shell/shell.css';
import App from './App.tsx';
import './styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Author shell root element was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
