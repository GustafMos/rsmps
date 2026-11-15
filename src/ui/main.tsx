import { createRoot } from 'react-dom/client';
import './tokens.css';
import './base.css';
import './boot.css';
import { Root } from './Root';

// No StrictMode: booting creates the GPU device and must happen exactly once.
createRoot(document.getElementById('root')!).render(<Root />);
