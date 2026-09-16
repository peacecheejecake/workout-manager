import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EchoForm } from './EchoForm';

const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <StrictMode>
    <EchoForm />
  </StrictMode>,
);
