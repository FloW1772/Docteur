export type BlockType = 'h1' | 'h2' | 'paragraph' | 'todo' | 'list' | 'image';
export type PageKind  = 'note' | 'task' | 'idea' | 'reference' | 'memory' | 'channel' | 'video' | 'link' | 'playlist' | 'question' | 'recherche' | 'cv' | 'candidature' | 'rapport' | 'prompt';

export interface Block {
  id:       string;
  type:     BlockType;
  content:  string;
  checked?: boolean;
}

export interface Page {
  id:        string;
  title:     string;
  blocks:    Block[];
  kind:      PageKind;
  createdAt: number;
  updatedAt: number;
  links?:    string[];   // IDs of bidirectional synapses
  color?:    string;
  tags?:     string[];
  metadata?: Record<string, unknown>;
  private?:  boolean;   // si true : jamais envoyé au cloud, quel que soit le router
}

export const KIND_META: Record<PageKind, { label: string; color: string; icon: string }> = {
  note:      { label: 'Note',      color: '#5ee7ff', icon: '◈' },
  task:      { label: 'Tâche',     color: '#3dffaa', icon: '◉' },
  idea:      { label: 'Idée',      color: '#ff4dcb', icon: '◆' },
  reference: { label: 'Référence', color: '#a78bfa', icon: '◇' },
  memory:    { label: 'Mémoire',   color: '#fb923c', icon: '◐' },
  channel:   { label: 'Channel',   color: '#ff8b3d', icon: '◉' },
  video:     { label: 'Vidéo',     color: '#a78bfa', icon: '▶' },
  link:      { label: 'Lien',      color: '#7dd3fc', icon: '⬡' },
  playlist:  { label: 'Playlist',  color: '#e879f9', icon: '≡' },
  question:    { label: 'Question',    color: '#00d4b1', icon: '?' },
  recherche:   { label: 'Recherche',   color: '#f59e0b', icon: '⌖' },
  cv:          { label: 'CV',          color: '#f472b6', icon: '◈' },
  candidature: { label: 'Candidature', color: '#fbbf24', icon: '✉' },
  rapport:     { label: 'Rapport',     color: '#7dd3fc', icon: '⬟' },
  prompt:      { label: 'Prompt',      color: '#34d399', icon: '›_' },
};

export const BLOCK_PLACEHOLDERS: Record<BlockType, string> = {
  h1:        'Titre principal',
  h2:        'Sous-titre',
  paragraph: 'Commence à écrire…',
  todo:      'Tâche à faire',
  list:      'Élément de liste',
  image:     '',
};
