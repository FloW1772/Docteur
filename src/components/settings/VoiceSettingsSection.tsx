import { useEffect, useState } from 'react';
import type { VoiceSettings } from '../../lib/cortex/client';
import { useMicrophoneDiagnostics } from '../../hooks/useMicrophoneDiagnostics';
import { DEFAULT_TTS_SETTINGS, getStoredTtsSettings, listTtsVoices, clampTtsRate, clampTtsVolume, type TtsSettings, type TtsState } from '../../lib/voiceTts';
import { VOICE_STATE_LABEL, type UnifiedVoiceState } from '../../lib/voiceLifecycle';
import type { VoiceMicMode } from '../../hooks/useVoiceCommandPipeline';
import type { VoiceState } from '../../hooks/useVoiceActivation';
import VoiceCommands from './VoiceCommands';

export interface VoiceRuntime {
  state: UnifiedVoiceState;
  captureState: VoiceState;
  mode: VoiceMicMode;
  ttsState: TtsState;
  sttLatencyMs: number | null;
}
interface Props {
  settings: VoiceSettings | null;
  strictLocal: boolean | null;
  saving: boolean;
  error: string | null;
  onSave: (updates: Partial<VoiceSettings>) => Promise<void>;
  runtime?: VoiceRuntime;
  onCancelVoice?: () => void;
}

export default function VoiceSettingsSection({ settings, strictLocal, saving, error, onSave, runtime, onCancelVoice }: Props) {
  const microphone = useMicrophoneDiagnostics();
  const [tts, setTts] = useState(getStoredTtsSettings);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  useEffect(() => {
    const refresh = () => setVoices(listTtsVoices());
    refresh();
    window.speechSynthesis?.addEventListener('voiceschanged', refresh);
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', refresh);
  }, []);
  // A new application interaction ends a diagnostic capture. Neither starts the other.
  useEffect(() => {
    if (runtime && runtime.state !== 'IDLE' && runtime.state !== 'ERROR') microphone.stopTest();
  }, [runtime?.state, microphone.stopTest]);

  function saveTts(update: Partial<TtsSettings>) {
    const next = { ...tts, ...update };
    try { localStorage.setItem('docteur.voice.tts', JSON.stringify(next)); setTts(next); setPreferenceError(null); }
    catch { setPreferenceError('Impossible de conserver ce réglage sur cet appareil.'); }
  }
  const captureActive = (microphone.testing && microphone.actualSettings !== null) || runtime?.captureState === 'recording' || runtime?.captureState === 'wake-listening';
  const cloud = strictLocal === false && settings?.whisperMode === 'groq';
  const processing = strictLocal === null || !settings ? 'Statut indisponible' : cloud ? 'CLOUD — Groq' : strictLocal ? 'LOCAL — Strict Local' : 'LOCAL — faster-whisper';
  const actual = microphone.actualSettings;
  const onOff = (value?: boolean) => value === undefined ? 'Non communiqué' : value ? 'ON' : 'OFF';
  const permission = { granted: 'Autorisée', denied: 'Refusée — autorisez le micro dans votre navigateur', prompt: 'À demander lors du test', unknown: 'Non communiquée' }[microphone.permission];
  return <section className="voice-settings" aria-labelledby="voice-settings-title">
    <header><h2 id="voice-settings-title">Voice & Microphone</h2><p>Dictez du texte, choisissez une commande ou écoutez une réponse.</p></header>
    {(error || preferenceError) && <p role="alert">{error || preferenceError}</p>}
    {!settings && <p role="status">Réglages vocaux indisponibles. Fermez puis rouvrez les paramètres pour réessayer.</p>}
    <fieldset><legend>Microphone</legend>
      <label>Microphone utilisé<select aria-label="Microphone utilisé" value={microphone.selectedDeviceId ?? ''} disabled={microphone.testing} onChange={e => microphone.selectDevice(e.target.value)}>
        <option value="">Microphone par défaut</option>
        {microphone.devices.filter(device => device.deviceId).map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
      </select></label>
      <p>Permission : <strong>{permission}</strong></p>
      <div className="voice-actions"><button type="button" disabled={microphone.testing} onClick={() => { onCancelVoice?.(); void microphone.startTest(); }}>Tester le microphone</button>
        <button type="button" disabled={!microphone.testing} onClick={microphone.stopTest}>Arrêter le test</button></div>
      <p>Le test micro reste local et n’est pas transcrit. Aucune commande n’est exécutée.</p>
      <p role="status">{microphone.testing ? microphone.actualSettings ? 'Microphone actif — test local' : 'Autorisation du microphone en cours…' : 'Test arrêté'}</p>
      <label>Niveau d’entrée<meter min={0} max={1} value={microphone.rms} aria-label="Niveau d’entrée du microphone" /></label>
      {microphone.error && <p role="alert">{microphone.error}</p>}
      <dl className="voice-metadata">
        <dt>Fréquence réelle</dt><dd>{actual?.sampleRate ? `${actual.sampleRate} Hz` : 'Disponible après un test'}</dd>
        <dt>Canaux</dt><dd>{actual?.channelCount ?? 'Non communiqué'}</dd>
        <dt>Annulation d’écho</dt><dd>{onOff(actual?.echoCancellation)}</dd>
        <dt>Réduction du bruit</dt><dd>{onOff(actual?.noiseSuppression)}</dd>
        <dt>Gain automatique</dt><dd>{onOff(actual?.autoGainControl)}</dd>
      </dl>
    </fieldset>
    <fieldset><legend>Speech to text</legend>
      <p>Traitement : <strong data-testid="voice-processing">{processing}</strong></p>
      <label>Reconnaissance vocale<select aria-label="Reconnaissance vocale" disabled={!settings || saving || strictLocal === null} value={strictLocal ? 'local' : settings?.whisperMode ?? 'local'} onChange={e => void onSave({ whisperMode: e.target.value as 'local' | 'groq' })}>
        <option value="local">LOCAL — faster-whisper</option><option value="groq" disabled={strictLocal !== false}>CLOUD — Groq Whisper</option>
      </select></label>
      <p>Langue : Français (fixe)</p>
      {strictLocal && <p>Strict Local actif : la reconnaissance cloud est désactivée.</p>}
      {cloud && <p role="note">L’audio de transcription est envoyé à Groq, le fournisseur choisi. Aucun repli cloud automatique.</p>}
    </fieldset>
    <fieldset><legend>Voice control</legend>
      <label className="voice-check"><input type="checkbox" checked={settings?.enabled ?? false} disabled={!settings || saving} onChange={e => void onSave({ enabled: e.target.checked })} />Activer l’interface vocale</label>
      <p>Mode au démarrage : <strong>DICTATION</strong>. Le mode COMMAND se choisit explicitement dans la barre de commande.</p>
      <p>Dictée : texte à relire avant envoi. Commande : action interprétée après validation du texte, avec confirmation supplémentaire si nécessaire.</p>
      <p><kbd>Alt+M</kbd> : microphone. STOP : annuler. Cliquer sur le micro pendant la lecture interrompt la voix de Docteur.</p>
      <VoiceCommands />
    </fieldset>
    <fieldset><legend>Text to speech</legend>
      <p>Fournisseur : <strong>{'speechSynthesis' in window ? 'SYSTEM / BROWSER' : 'INDISPONIBLE'}</strong></p>
      <label className="voice-check"><input type="checkbox" checked={tts.enabled} onChange={e => { saveTts({ enabled: e.target.checked }); if (!e.target.checked) onCancelVoice?.(); }} />Synthèse vocale activée</label>
      <label className="voice-check"><input type="checkbox" checked={tts.autoSpeak} disabled={!tts.enabled} onChange={e => saveTts({ autoSpeak: e.target.checked })} />Lire les réponses à voix haute</label>
      <p>Lecture automatique désactivée par défaut.</p>
      <label>Voix<select aria-label="Voix de synthèse" value={tts.voiceName} onChange={e => saveTts({ voiceName: e.target.value })}><option value="">Voix par défaut du système</option>{voices.map(voice => <option key={`${voice.name}-${voice.lang}`} value={voice.name}>{voice.name} ({voice.lang}) — {voice.localService ? 'système local' : 'service distant'}</option>)}</select></label>
      <label>Vitesse : {tts.rate.toFixed(1)}<input aria-label="Vitesse de lecture" type="range" min="0.5" max="2" step="0.1" value={tts.rate} onChange={e => saveTts({ rate: clampTtsRate(Number(e.target.value)) })} /></label>
      <label>Volume : {Math.round(tts.volume * 100)} %<input aria-label="Volume de lecture" type="range" min="0" max="1" step="0.05" value={tts.volume} onChange={e => saveTts({ volume: clampTtsVolume(Number(e.target.value)) })} /></label>
      <p>Les voix sont fournies par votre navigateur. Certaines utilisent un service distant ; le réglage Strict Local ci-dessus concerne la transcription.</p>
    </fieldset>
    <fieldset aria-label="Voice Privacy"><legend>Voice Privacy</legend>
      <dl className="voice-metadata">
        <dt>Microphone</dt><dd>{captureActive ? 'ACTIVE' : runtime ? 'INACTIVE' : 'État applicatif indisponible'}</dd>
        <dt>STT</dt><dd>{processing}</dd><dt>TTS</dt><dd>{tts.enabled && 'speechSynthesis' in window ? 'SYSTEM / BROWSER' : 'OFF'}</dd>
        <dt>Audio cloud (STT autorisé)</dt><dd>{strictLocal === null || !settings ? 'Indisponible' : cloud && settings.enabled ? 'ON' : 'OFF'}</dd>
        <dt>Commandes vocales</dt><dd>{settings?.enabled && runtime?.mode === 'COMMAND' ? 'ON' : 'OFF'}</dd>
        <dt>Écoute permanente</dt><dd>NOT IMPLEMENTED</dd>
        <dt>Mot d’activation existant</dt><dd>{runtime?.captureState === 'wake-listening' ? 'Écoute active' : settings?.porcupineAccessKey && settings.hasPorcupineModel ? 'Configuré' : 'Non configuré'}</dd>
        <dt>Conservation audio</dt><dd>NOT STORED — pas d’archive ; fichier temporaire supprimé après transcription</dd>
      </dl>
    </fieldset>
    <details><summary>Diagnostics vocaux</summary>
      <p>Métadonnées uniquement. Aucun audio, transcript, identifiant complet ou secret.</p>
      <dl className="voice-metadata">
        <dt>RMS</dt><dd>{microphone.rms.toFixed(3)}</dd><dt>Peak</dt><dd>{microphone.peak.toFixed(3)}</dd>
        <dt>Clipping</dt><dd>{microphone.clippingStatus}</dd><dt>Bruit de fond</dt><dd>{microphone.noiseFloor?.toFixed(3) ?? 'Non mesuré'}</dd>
        <dt>Détection vocale</dt><dd>{microphone.vadState}</dd><dt>STT</dt><dd>{processing}</dd>
        <dt>Dernière latence STT</dt><dd>{runtime?.sttLatencyMs == null ? 'Non mesurée' : `${Math.round(runtime.sttLatencyMs)} ms`}</dd>
        <dt>TTS</dt><dd>{runtime?.ttsState ?? 'Non disponible'}</dd><dt>Session vocale</dt><dd>{runtime ? VOICE_STATE_LABEL[runtime.state] : 'Non disponible'}</dd>
      </dl>
    </details>
    <button type="button" onClick={() => saveTts(DEFAULT_TTS_SETTINGS)}>Réinitialiser les préférences de lecture</button>
    <p>Rétablit la voix système, la vitesse et le volume par défaut ; lecture automatique OFF. Les autres réglages sont conservés.</p>
  </section>;
}
