import { useEffect, useState, useCallback } from 'react';
import { Eye, EyeOff, Save, Trash2, RefreshCw, CircleCheck, CircleAlert, CircleX, Clock, Link2, Unlink, HelpCircle } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type { ConnectorId, ConnectorState } from '../../lib/cortex/client';

const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6, color: '#e2e8f0', padding: '7px 10px', fontSize: 12, width: '100%',
  fontFamily: 'monospace', outline: 'none',
};
const btnGhostStyle: React.CSSProperties = {
  background: 'none', border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6, color: '#94a3b8', padding: '6px 12px', fontSize: 11, cursor: 'pointer',
  fontFamily: 'monospace', display: 'inline-flex', alignItems: 'center', gap: 6,
};
const btnPrimaryStyle: React.CSSProperties = {
  background: 'rgba(61,255,170,0.1)', border: '1px solid rgba(61,255,170,0.3)',
  borderRadius: 6, color: '#3dffaa', padding: '6px 12px', fontSize: 11, cursor: 'pointer',
  fontFamily: 'monospace', display: 'inline-flex', alignItems: 'center', gap: 6,
};
const btnDangerStyle: React.CSSProperties = {
  background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)',
  borderRadius: 6, color: '#f87171', padding: '6px 12px', fontSize: 11, cursor: 'pointer',
  fontFamily: 'monospace', display: 'inline-flex', alignItems: 'center', gap: 6,
};
const sectionLabelStyle: React.CSSProperties = { fontFamily: 'monospace', fontSize: 10, color: '#3d3060', letterSpacing: '0.1em' };

// Card copy — vérifié Phase Audit : le backend ne fait strictement rien de plus
// que ce que ces phrases décrivent (aucun appel réel tant que Connecter n'a
// pas été explicitement cliqué par l'utilisateur, hors scope de cette mission).
const CONNECTOR_COPY: Partial<Record<ConnectorId, string>> = {
  youtube: 'Connecter votre compte YouTube pour importer les contenus autorisés.',
  google_drive: 'Sélectionner ultérieurement les fichiers Drive auxquels Docteur pourra accéder.',
  onedrive: 'Importer des fichiers OneDrive autorisés dans Docteur.',
};

type DisplayStatus = 'not_configured' | 'configured' | 'connected' | 'error' | 'unavailable';

function computeStatus(c: ConnectorState): DisplayStatus {
  if (c.status === 'unsupported') return 'unavailable';
  if (c.connected) return c.last_sync_status === 'error' ? 'error' : 'connected';
  if (c.client_configured) return 'configured';
  return 'not_configured';
}

const STATUS_META: Record<DisplayStatus, { label: string; color: string; icon: typeof CircleCheck }> = {
  not_configured: { label: 'Non configuré', color: '#5a4a7a', icon: CircleX },
  configured:     { label: 'Configuré',      color: '#5ee7ff', icon: CircleCheck },
  connected:      { label: 'Connecté',       color: '#3dffaa', icon: CircleCheck },
  error:          { label: 'Erreur',         color: '#ff4d58', icon: CircleAlert },
  unavailable:    { label: 'Indisponible',   color: '#3d3060', icon: Clock },
};

function StatusBadge({ status }: { status: DisplayStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      className="font-mono inline-flex items-center gap-1"
      style={{ fontSize: 10, color: meta.color, border: `1px solid ${meta.color}44`, background: `${meta.color}14`, borderRadius: 4, padding: '2px 7px', letterSpacing: '0.04em' }}
    >
      <Icon size={10} /> {meta.label}
    </span>
  );
}

function ConnectorCard({ connector, onChanged }: { connector: ConnectorState; onChanged: () => void }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const status = computeStatus(connector);
  const canSave = clientId.trim().length > 0 && clientSecret.trim().length > 0;
  // "Connecter" requires a saved app registration first — never enabled just
  // because the two fields are filled in the draft (they must be saved).
  const canConnect = connector.client_configured && !connector.connected;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await cortexClient.saveConnectorCredentials(connector.id, clientId.trim(), clientSecret.trim());
      setClientId('');
      setClientSecret('');
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteCredentials() {
    setSaving(true);
    setError(null);
    try {
      await cortexClient.deleteConnectorCredentials(connector.id);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    setSaving(true);
    setError(null);
    try {
      // Never sends delete_synced_data — synced neurons/Notebook content stay.
      await cortexClient.disconnectConnector(connector.id);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5 px-3 py-3 rounded" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-center justify-between">
        <span className="font-grotesk font-semibold text-xs" style={{ color: '#f0eaff' }}>{connector.label}</span>
        <StatusBadge status={status} />
      </div>

      <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', lineHeight: 1.6 }}>
        {CONNECTOR_COPY[connector.id] ?? ''}
      </p>

      {connector.connected && connector.account_label && (
        <p className="font-mono text-xs" style={{ color: '#3dffaa' }}>Compte : {connector.account_label}</p>
      )}
      {status === 'error' && connector.last_sync_error && (
        <p className="font-mono text-xs" style={{ color: '#ff4d58' }}>Dernière synchro en erreur : {connector.last_sync_error}</p>
      )}

      {error && <p className="font-mono text-xs" style={{ color: '#ff4d58' }}>{error}</p>}

      {/* Client ID / Client Secret — never pre-filled with the stored value */}
      <div className="flex flex-col gap-1.5">
        <label className="flex flex-col gap-1">
          <span className="font-mono" style={{ fontSize: 10, color: '#7a6c9a' }}>Client ID</span>
          <input
            type="text"
            value={clientId}
            onChange={e => setClientId(e.target.value)}
            placeholder={connector.client_configured ? 'Enregistré — laisser vide pour conserver' : 'Client ID OAuth…'}
            style={inputStyle}
            disabled={saving}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono" style={{ fontSize: 10, color: '#7a6c9a' }}>Client Secret</span>
          <div className="relative">
            <input
              type={showSecret ? 'text' : 'password'}
              value={clientSecret}
              onChange={e => setClientSecret(e.target.value)}
              placeholder={connector.client_configured ? 'Secret enregistré — laisser vide pour conserver' : 'Client Secret OAuth…'}
              style={{ ...inputStyle, paddingRight: 30 }}
              disabled={saving}
            />
            <button type="button" onClick={() => setShowSecret(v => !v)} style={{ position: 'absolute', right: 6, top: 6, background: 'none', border: 'none', color: '#5a4a7a', cursor: 'pointer' }}>
              {showSecret ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          </div>
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void handleSave()} disabled={saving || !canSave} style={{ ...btnGhostStyle, opacity: !canSave ? 0.5 : 1 }}>
          <Save size={11} /> Enregistrer la configuration
        </button>
        <button
          type="button"
          disabled={saving || !canConnect}
          title={!connector.client_configured ? 'Enregistrez la configuration d\'abord' : connector.connected ? 'Déjà connecté' : undefined}
          style={{ ...btnPrimaryStyle, opacity: !canConnect ? 0.4 : 1, cursor: !canConnect ? 'default' : 'pointer' }}
        >
          <Link2 size={11} /> Connecter
        </button>
        {connector.connected && (
          <button type="button" onClick={() => void handleDisconnect()} disabled={saving} style={btnDangerStyle}>
            <Unlink size={11} /> Déconnecter
          </button>
        )}
        {connector.client_configured && !connector.connected && (
          <button type="button" onClick={() => void handleDeleteCredentials()} disabled={saving} style={{ ...btnGhostStyle, color: '#7a6c9a' }}>
            <Trash2 size={11} /> Effacer la configuration
          </button>
        )}
      </div>

      <button type="button" onClick={() => setShowHelp(v => !v)} className="font-mono self-start" style={{ fontSize: 10, color: '#5ee7ff', background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <HelpCircle size={11} /> Comment obtenir mes identifiants ?
      </button>
      {showHelp && (
        <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', lineHeight: 1.6, background: 'rgba(255,255,255,0.02)', borderRadius: 6, padding: '8px 10px' }}>
          Les identifiants (Client ID / Client Secret) se créent dans la console développeur du fournisseur
          ({connector.clientFamily === 'google' ? 'Google Cloud Console' : connector.clientFamily === 'microsoft' ? 'Azure / Microsoft Entra' : 'la console du fournisseur'}),
          en enregistrant une application OAuth. Cette étape se fait en dehors de Docteur — revenez ici ensuite
          pour les renseigner ci-dessus et cliquer sur « Enregistrer la configuration ».
        </p>
      )}
    </div>
  );
}

const GOOGLE_IDS: ConnectorId[] = ['youtube', 'google_drive'];
const MICROSOFT_IDS: ConnectorId[] = ['onedrive'];

export function ConnectionsSettingsTab() {
  const [connectors, setConnectors] = useState<ConnectorState[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await cortexClient.listConnectors();
      setConnectors(r.connectors);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw size={16} className="animate-spin" style={{ color: '#3d3060' }} />
      </div>
    );
  }

  if (!connectors) {
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        <CircleAlert size={18} style={{ color: '#ff4d58' }} />
        <p className="font-mono text-xs" style={{ color: '#ff4d58' }}>{error ?? 'Erreur de chargement'}</p>
        <button type="button" onClick={() => { setLoading(true); void reload(); }} style={btnGhostStyle}>
          <RefreshCw size={11} /> Réessayer
        </button>
      </div>
    );
  }

  const byId = new Map(connectors.map(c => [c.id, c]));
  const upcoming = connectors.filter(c => c.status === 'unsupported');

  return (
    <div className="p-4" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <p className="font-mono text-xs" style={{ color: '#5a4a7a', lineHeight: 1.6 }}>
        Importe des contenus autorisés depuis d'autres services — toujours marqués privés/local, jamais transmis à un provider cloud.
        Aucune connexion réelle n'est lancée tant que vous ne cliquez pas explicitement sur « Connecter ».
      </p>

      {error && <p className="font-mono text-xs" style={{ color: '#ff4d58' }}>{error}</p>}

      <div>
        <div style={sectionLabelStyle}>GOOGLE</div>
        <div className="flex flex-col gap-2 mt-2">
          {GOOGLE_IDS.map(id => byId.get(id)).filter((c): c is ConnectorState => !!c).map(c => (
            <ConnectorCard key={c.id} connector={c} onChanged={() => void reload()} />
          ))}
        </div>
      </div>

      <div>
        <div style={sectionLabelStyle}>MICROSOFT</div>
        <div className="flex flex-col gap-2 mt-2">
          {MICROSOFT_IDS.map(id => byId.get(id)).filter((c): c is ConnectorState => !!c).map(c => (
            <ConnectorCard key={c.id} connector={c} onChanged={() => void reload()} />
          ))}
        </div>
      </div>

      {upcoming.length > 0 && (
        <div>
          <div style={sectionLabelStyle}>À VENIR</div>
          <div className="flex flex-wrap gap-2 mt-2">
            {upcoming.map(c => (
              <span key={c.id} className="font-mono inline-flex items-center gap-1.5" style={{ fontSize: 11, color: '#5a4a7a', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: '5px 10px' }}>
                <Clock size={11} /> {c.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
