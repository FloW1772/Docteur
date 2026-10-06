// Professeur V2 (PROF-3) browser harness: mounts the REAL TeacherModal alone (App.tsx untouched / not needed).
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/globals.css';
import TeacherModal from '../src/components/modals/TeacherModal';

export function mount() {
  window.__teacherClosed = 0;
  createRoot(document.getElementById('root')).render(
    <TeacherModal onClose={() => { window.__teacherClosed += 1; }} strictLocalMode={true} />,
  );
}
