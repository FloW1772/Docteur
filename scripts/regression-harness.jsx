import React, { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { usePages } from '../src/hooks/usePages';
import { agentPageData } from '../src/lib/agent-page';
import { PageEditor } from '../src/App';
import Sidebar from '../src/components/layout/Sidebar';
import AgentsModal from '../src/components/modals/AgentsModal';
import { useModalOpenTracking, useAnyModalOpen } from '../src/hooks/useModalRegistry';
import '../src/styles/globals.css';

function Harness() {
  const api = usePages();
  const [selected, select] = useState(null);
  const [agentsOpen, setAgentsOpen] = useState(false);
  useModalOpenTracking(agentsOpen);
  const modalOpen = useAnyModalOpen();
  useEffect(() => { if (selected) void api.loadPage(selected); }, [selected, api.loadPage]);
  window.regression = { ...api, select, modalOpen, openAgents: () => setAgentsOpen(true), async agent(output) {
    const page = await api.createPageFromData(agentPageData(output));
    select(page.id);
    return page;
  } };
  const page = api.pages.find(p => p.id === selected);
  return <>
    {agentsOpen && <AgentsModal onClose={() => setAgentsOpen(false)} onAgentOutput={async output => {
      await window.regression.agent(output);
      setAgentsOpen(false);
    }} />}
    <div className="shell-sidebar"><div style={{pointerEvents: "auto"}}><Sidebar pages={api.pages} selectedPageId={selected} loading={api.loading}
      cortexAvailable onSelectPage={select} onNewPage={() => {}} onDeletePage={() => {}} onRequestReindex={() => {}}
      showHomeScreen={false} onToggleHomeScreen={() => {}} onCaptureOpen={() => {}} onSearchOpen={() => {}}
      allMetaLoaded={api.allMetaLoaded} onLoadAllPages={api.loadAllMeta} /></div></div>
    {page && <div className="shell-editor"><PageEditor page={page} allPages={api.pages} onUpdate={api.updatePage}
      onReviewPage={async () => {}} onRegenerateVeille={async () => {}} onClose={() => select(null)} onDelete={() => {}} onOpenLinkPicker={() => {}} onRemoveLink={() => {}} onNavigateTo={select} /></div>}
  </>;
}
export function mount() { createRoot(document.getElementById('root')).render(<StrictMode><Harness /></StrictMode>); }
