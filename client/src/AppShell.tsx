import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { HomeDashboard } from './views/HomeDashboard.tsx'
import { WorkflowView } from './views/WorkflowView.tsx'
import { DetectView } from './views/DetectView.tsx'
import { Toaster } from './components/Toaster.tsx'
import { useGenerationWatcher } from './hooks/useGenerationWatcher.ts'

export function AppShell() {
  useGenerationWatcher()
  return (
    <BrowserRouter>
      <Toaster />
      <Routes>
        <Route path="/" element={<HomeDashboard />} />
        <Route path="/detect" element={<DetectView />} />
        <Route path="/w/:id" element={<Navigate to="build" replace />} />
        <Route path="/w/:id/:mode" element={<WorkflowView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
