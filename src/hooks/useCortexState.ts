// Central Cortex visual state — a single derived enum summarizing what
// Docteur is currently doing, for any UI element (the 3D core, a status
// pill, an activity panel) to react to consistently. Never a new source of
// truth: every input here already exists elsewhere in the app (voice
// activation state, cortex queue/indexing, active jobs, last error) — this
// hook only maps them onto one shared vocabulary, the same way TopBar
// already maps VoiceState/GestureState/ScreenShareState to labels/colors.
import { useMemo } from 'react';
import type { VoiceState } from './useVoiceActivation';

export type CortexVisualState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'searching'
  | 'generating'
  | 'done'
  | 'error';

export interface CortexStateInputs {
  cortexAvailable: boolean;
  cortexBusy: boolean;
  voiceState?: VoiceState;
  /** True while a search/console query is in flight (SearchConsole, web/local search). */
  searchActive?: boolean;
  /** True while any long-running job (MetaGPT planning/codegen, video render, batch, reindex) is active. */
  generatingActive?: boolean;
  /** Set briefly after a generation/search completes, to show a "done" pulse before returning to idle. */
  justCompleted?: boolean;
}

export const CORTEX_STATE_LABEL: Record<CortexVisualState, string> = {
  idle: '',
  listening: 'En écoute',
  thinking: 'Réflexion…',
  searching: 'Recherche…',
  generating: 'Génération…',
  done: 'Terminé',
  error: 'Erreur',
};

export const CORTEX_STATE_COLOR: Record<CortexVisualState, string> = {
  idle: '#7a6c9a',
  listening: '#3dffaa',
  thinking: '#5ee7ff',
  searching: '#5ee7ff',
  generating: '#ffb547',
  done: '#3dffaa',
  error: '#ff4d58',
};

/**
 * Priority order matters: an explicit error always wins, then active voice
 * capture (user is mid-interaction), then background generation/search
 * work, then the transient "done" pulse, then plain idle/thinking.
 */
export function deriveCortexState(inputs: CortexStateInputs): CortexVisualState {
  if (!inputs.cortexAvailable) return 'error';
  if (inputs.voiceState === 'wake-listening' || inputs.voiceState === 'recording') return 'listening';
  if (inputs.voiceState === 'transcribing') return 'thinking';
  if (inputs.generatingActive) return 'generating';
  if (inputs.searchActive) return 'searching';
  if (inputs.cortexBusy) return 'thinking';
  if (inputs.justCompleted) return 'done';
  return 'idle';
}

export function useCortexState(inputs: CortexStateInputs): CortexVisualState {
  return useMemo(() => deriveCortexState(inputs), [
    inputs.cortexAvailable,
    inputs.cortexBusy,
    inputs.voiceState,
    inputs.searchActive,
    inputs.generatingActive,
    inputs.justCompleted,
  ]);
}
