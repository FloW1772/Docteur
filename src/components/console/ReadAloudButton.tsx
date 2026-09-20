import { Volume2 } from 'lucide-react';
import { canManuallySpeak } from '../../lib/voiceResponsePolicy';

export default function ReadAloudButton({ text, onRead }: { text: string; onRead: () => void }) {
  if (!canManuallySpeak(text)) return null;
  return <button type="button" onClick={onRead} title="Lire cette réponse à voix haute" className="voice-read-aloud"><Volume2 size={14} aria-hidden="true" /> Lire à voix haute</button>;
}
