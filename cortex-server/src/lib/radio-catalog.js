// ── Catalogue des radios Internet ────────────────────────────────────────────
// Chaque entrée a été vérifiée par une vraie requête HTTP (Node fetch ET
// Chromium réel) le 2026-09-15 : statut 200, Content-Type audio/*, lecture
// <audio> confirmée (event `playing`, currentTime > 0).
//
// Les flux SomaFM précédents (groovesalad, gsclassic, lush, deepspaceone)
// renvoient 403 depuis un navigateur réel dans cet environnement (blocage
// probable par fingerprint TLS/HTTP côté SomaFM — confirmé reproductible :
// curl et Chromium reçoivent 403, alors qu'un `fetch` Node/undici obtient 200
// sur la même URL). Ils sont retirés du catalogue plutôt que masqués derrière
// un proxy, car le problème n'est pas côté serveur mais côté edge SomaFM.
export const RADIO_STATIONS = [
  { id: 'radioparadise-main',   name: 'Radio Paradise (Main Mix)', genre: 'Éclectique', url: 'https://stream.radioparadise.com/mp3-192',            codec: 'mp3' },
  { id: 'radioparadise-mellow', name: 'Radio Paradise Mellow',     genre: 'Ambiant',    url: 'https://stream.radioparadise.com/mellow-192',          codec: 'mp3' },
  { id: 'kexp',                 name: 'KEXP Seattle',              genre: 'Rock/Indie', url: 'https://kexp-mp3-128.streamguys1.com/kexp128.mp3',    codec: 'mp3' },
  { id: 'fip',                  name: 'FIP (Radio France)',        genre: 'Éclectique', url: 'https://icecast.radiofrance.fr/fip-midfi.mp3',        codec: 'mp3' },
  { id: 'franceinfo',           name: 'France Info',               genre: 'Actualités', url: 'https://icecast.radiofrance.fr/franceinfo-midfi.mp3', codec: 'mp3' },
];

export function getRadioStations() {
  return RADIO_STATIONS;
}

export function getRadioStationById(id) {
  return RADIO_STATIONS.find(s => s.id === id) ?? null;
}
