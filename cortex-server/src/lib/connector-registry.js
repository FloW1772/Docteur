// Connector Center — registry of every connector Docteur knows about
// (Batch D, "Centre de connexions" mission, Phase 1: backend only).
//
// This is the single source of truth for which connector ids exist and
// which of them are actually wired up. routes/connectors.js gates every
// provider-scoped route (client-credentials, auth-url, callback, sync,
// disconnect, auto-sync) against isActiveConnector() BEFORE touching
// OAuth/secret-store/fetch — a registered-but-unsupported id (Dropbox,
// GitHub, ...) gets the same 404 as an unknown id. No Connect button, no
// OAuth, no fetch is structurally reachable for a non-active connector.

export const CONNECTOR_STATUS = Object.freeze({
  ACTIVE: 'active',
  UNSUPPORTED: 'unsupported',
});

export const CONNECTOR_CATEGORY = Object.freeze({
  VIDEO: 'video',
  STORAGE: 'storage',
  PRODUCTIVITY: 'productivity',
  CALENDAR: 'calendar',
  CODE: 'code',
});

// clientFamily describes the OAuth vendor only. Credentials remain keyed
// independently by connector id, preserving existing registrations without
// migration or implicit overwrites (including between Google connectors).
export const CONNECTORS = Object.freeze([
  {
    id: 'youtube', label: 'YouTube', category: CONNECTOR_CATEGORY.VIDEO, status: CONNECTOR_STATUS.ACTIVE,
    capabilities: ['list_uploaded_videos', 'list_playlists', 'list_liked_videos'],
    authType: 'oauth2_pkce', privacyPolicy: 'local_only', clientFamily: 'google',
  },
  {
    id: 'google_drive', label: 'Google Drive', category: CONNECTOR_CATEGORY.STORAGE, status: CONNECTOR_STATUS.ACTIVE,
    capabilities: ['list_picked_files', 'read_file_content'],
    authType: 'oauth2_pkce', privacyPolicy: 'local_only', clientFamily: 'google',
  },
  {
    id: 'onedrive', label: 'OneDrive', category: CONNECTOR_CATEGORY.STORAGE, status: CONNECTOR_STATUS.ACTIVE,
    capabilities: ['list_files', 'read_file_content'],
    authType: 'oauth2_pkce', privacyPolicy: 'local_only', clientFamily: 'microsoft',
  },
  {
    id: 'dropbox', label: 'Dropbox', category: CONNECTOR_CATEGORY.STORAGE, status: CONNECTOR_STATUS.UNSUPPORTED,
    capabilities: [], authType: 'none', privacyPolicy: 'local_only', clientFamily: null,
  },
  {
    id: 'github', label: 'GitHub', category: CONNECTOR_CATEGORY.CODE, status: CONNECTOR_STATUS.UNSUPPORTED,
    capabilities: [], authType: 'none', privacyPolicy: 'local_only', clientFamily: null,
  },
  {
    id: 'notion', label: 'Notion', category: CONNECTOR_CATEGORY.PRODUCTIVITY, status: CONNECTOR_STATUS.UNSUPPORTED,
    capabilities: [], authType: 'none', privacyPolicy: 'local_only', clientFamily: null,
  },
  {
    id: 'google_calendar', label: 'Google Calendar', category: CONNECTOR_CATEGORY.CALENDAR, status: CONNECTOR_STATUS.UNSUPPORTED,
    capabilities: [], authType: 'none', privacyPolicy: 'local_only', clientFamily: null,
  },
  {
    id: 'outlook_calendar', label: 'Outlook / Calendar', category: CONNECTOR_CATEGORY.CALENDAR, status: CONNECTOR_STATUS.UNSUPPORTED,
    capabilities: [], authType: 'none', privacyPolicy: 'local_only', clientFamily: null,
  },
]);

const BY_ID = new Map(CONNECTORS.map(c => [c.id, c]));

export function getConnectorDefinition(id) {
  return BY_ID.get(id) ?? null;
}

export function isActiveConnector(id) {
  return BY_ID.get(id)?.status === CONNECTOR_STATUS.ACTIVE;
}

export function listConnectorDefinitions() {
  return CONNECTORS;
}
