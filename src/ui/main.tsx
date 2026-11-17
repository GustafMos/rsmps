import { createRoot } from 'react-dom/client';
import './tokens.css';
import './base.css';
import './boot.css';
import { installViewportAttributes } from './responsive/viewport';
import { Root } from './Root';
import { ErrorBoundary } from './components/ErrorBoundary';

// Phone / tablet / desktop and touch as attributes on <html>, before the first render (the boot and error screens use them too).
installViewportAttributes();

// No StrictMode: booting creates the GPU device and must happen exactly once.
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <Root />
  </ErrorBoundary>,
);
