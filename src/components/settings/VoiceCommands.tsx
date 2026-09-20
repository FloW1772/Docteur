import { VOICE_INTENTS } from '../../lib/voiceIntentRegistry';
import { HELP_DIRECTORY } from '../../content/capabilities';
import { parseDeterministicIntent } from '../../lib/voiceIntentParser';

const featureExamples = HELP_DIRECTORY.flatMap(category => category.items).flatMap(item => {
  const example = [item.name, ...(item.keywords ?? [])].map(name => `ouvre ${name}`).find(text => {
    const parsed = parseDeterministicIntent(text);
    return parsed.type === 'OPEN_FEATURE' && 'featureId' in parsed.parameters && parsed.parameters.featureId === item.feature;
  });
  return example ? [{ feature: item.feature, text: example }] : [];
});

/** Registry descriptions are the catalogue; no parallel command/action allowlist. */
export default function VoiceCommands({ compact = false }: { compact?: boolean }) {
  const commands = Object.values(VOICE_INTENTS).filter(intent =>
    intent.riskLevel !== 'LEVEL_3' && !['UNKNOWN', 'NEEDS_CLARIFICATION', 'EXPLAIN_FEATURE'].includes(intent.id));
  return <details className="voice-commands">
    <summary>{compact ? 'Commandes' : 'Commandes vocales disponibles'}</summary>
    <p>Choisissez Commande avant de parler. Une commande inconnue n’exécute aucune action.</p>
    <ul>{commands.map(intent => <li key={intent.id} data-intent={intent.id}>
      <span>{intent.description.replace(/\s*\(migré depuis[^)]*\)/, '')}</span>
      {intent.id === 'OPEN_FEATURE' && <ul>{featureExamples.map(example => <li key={example.feature}>« {example.text} »</li>)}</ul>}
      {(intent.requiresConfirmation || intent.riskLevel === 'LEVEL_2') && <strong> — Confirmation requise</strong>}
    </li>)}</ul>
    <p>STOP annule l’interaction vocale. L’interruption automatique par la voix et l’explication locale ne sont pas disponibles.</p>
  </details>;
}
