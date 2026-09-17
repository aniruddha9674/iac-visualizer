import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import App from './App.jsx';

createRoot(document.getElementById('app')).render(
  <ReactFlowProvider>
    <App />
  </ReactFlowProvider>
);