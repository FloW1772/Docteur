// Knowledge Graph V1 — KG_PROD_POPULATION_MECH_1: YouTube library adapter (pure; no I/O, no KG write).
//
// Turns Neurone pages into a bounded STRUCTURAL description of the user's YouTube library:
//   video (DOCUMENT, identity = YouTube video id)        — one per distinct id, duplicate neurons fold into it
//   channel collection (ARTEFACT, identity = neuron id)  — a Docteur-local collection, NOT a YouTube channel identity
//   playlist (ARTEFACT, identity = YouTube playlist id)
//   video MEMBER_OF collection / playlist                — local library membership only
//
// metadata.channelId on a video neuron is the INTERNAL page id of the channel neuron the video was saved under
// (sqlite.repairLinksFromMetadata). It is never interpreted as publisher / creator / uploader: no claim, no
// PUBLISHED_BY / CREATED_BY relation is ever produced from it.
//
// Only ids, a structural fingerprint and a bounded display label leave this module. Page bodies (blocks), AI fields
// (deep_capture, model_used, summaries), pasted text, thumbnails, notes, CVs and every other kind are never read
// into an item. Labels are UNTRUSTED data (display / search only).

import crypto from 'node:crypto';

export const YOUTUBE_ADAPTER_ID = 'youtube_library';
export const YOUTUBE_ADAPTER_VERSION = 1;
export const MAX_LABEL_CHARS = 200;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
const YT_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'youtu.be']);

/** YouTube video id from a URL (watch?v=, youtu.be/, shorts/, embed/, live/, v/), or null. Playback params are ignored. */
export function videoIdFromUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!YT_HOSTS.has(host)) return null;
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1] ?? null;
  else if (u.pathname === '/watch') id = u.searchParams.get('v');
  else {
    const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
    id = m ? m[1] : null;
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

/** The stable video id of a video neuron: every reliable candidate must agree, otherwise nothing is guessed. */
export function videoIdentity(page) {
  const m = page?.metadata ?? {};
  const candidates = [m.videoId, m.youtubeId].filter(v => typeof v === 'string' && VIDEO_ID.test(v));
  const fromUrl = videoIdFromUrl(m.url);
  if (fromUrl) candidates.push(fromUrl);
  const distinct = [...new Set(candidates)];
  if (distinct.length === 0) return { ok: false, reason: 'VIDEO_ID_UNSUPPORTED' };
  if (distinct.length > 1) return { ok: false, reason: 'VIDEO_ID_CONFLICT' };
  return { ok: true, videoId: distinct[0] };
}

/** Untrusted display label: bounded, control characters removed, never empty (falls back to a neutral label). */
export function boundedLabel(raw, fallback) {
  const s = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return (s || fallback).slice(0, MAX_LABEL_CHARS);
}

const fingerprint = (parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
const isPrivate = (p) => p?.private === true || p?.private === 1;
const ts = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : (typeof v === 'number' && Number.isFinite(v) ? new Date(v).toISOString() : null));

/**
 * Pure structural plan of the YouTube library.
 * @param {Iterable<{id:string, data:object}>} pages parsed Neurone pages
 * @returns {{ videos: Map, collections: Map, playlists: Map, sourceNeurons: object[], skipped: object, counts: object }}
 */
export function buildYoutubeLibraryPlan(pages) {
  const byId = new Map();
  for (const p of pages) if (p && typeof p.id === 'string' && p.data && typeof p.data === 'object') byId.set(p.id, p.data);
  const skipped = { privateVideo: 0, videoIdUnsupported: 0, videoIdConflict: 0, collectionUnresolved: 0, collectionPrivate: 0, playlistInvalid: 0, playlistUnresolved: 0 };

  // playlists: only real playlist neurons with a valid YouTube playlist id (identity = playlist id)
  const playlistNeuronsById = new Map();
  for (const [pageId, d] of byId) {
    if (d.kind !== 'playlist' || isPrivate(d)) continue;
    const pl = d.metadata?.playlistId;
    if (typeof pl !== 'string' || !PLAYLIST_ID.test(pl)) continue;
    if (!playlistNeuronsById.has(pl)) playlistNeuronsById.set(pl, []);
    playlistNeuronsById.get(pl).push(pageId);
  }

  const videos = new Map(); // videoId → { videoId, neurons:[{pageId, label, fp, observedAt, versionRef, collectionPageId, playlistId}] }
  const collections = new Map(); // channel neuron pageId → { pageId, label, observedAt, versionRef }
  const playlists = new Map(); // playlistId → { playlistId, neurons:[{pageId,label,observedAt,versionRef}] }
  const sourceNeurons = [];
  for (const [pageId, d] of byId) {
    if (d.kind !== 'video') continue;
    if (isPrivate(d)) { skipped.privateVideo++; continue; }
    const vid = videoIdentity(d);
    if (!vid.ok) { skipped[vid.reason === 'VIDEO_ID_CONFLICT' ? 'videoIdConflict' : 'videoIdUnsupported']++; continue; }
    // collection membership: channelId must name an existing, non-private CHANNEL neuron — never fabricated
    let collectionPageId = null;
    const cid = d.metadata?.channelId;
    if (typeof cid === 'string' && cid) {
      const c = byId.get(cid);
      if (!c || c.kind !== 'channel') skipped.collectionUnresolved++;
      else if (isPrivate(c)) skipped.collectionPrivate++;
      else {
        collectionPageId = cid;
        if (!collections.has(cid)) collections.set(cid, { pageId: cid, label: boundedLabel(c.title, 'Collection'), observedAt: ts(c.createdAt), versionRef: ts(c.updatedAt) });
      }
    }
    // playlist membership: a valid YouTube playlist id that a playlist neuron carries
    let playlistId = null;
    const pl = d.metadata?.playlistId;
    if (typeof pl === 'string' && pl) {
      if (!PLAYLIST_ID.test(pl)) skipped.playlistInvalid++;
      else if (!playlistNeuronsById.has(pl)) skipped.playlistUnresolved++;
      else {
        playlistId = pl;
        if (!playlists.has(pl)) {
          playlists.set(pl, { playlistId: pl, neurons: playlistNeuronsById.get(pl).map(id => ({ pageId: id, label: boundedLabel(byId.get(id).title, 'Playlist'), observedAt: ts(byId.get(id).createdAt), versionRef: ts(byId.get(id).updatedAt) })) });
        }
      }
    }
    const neuron = {
      pageId, videoId: vid.videoId, label: boundedLabel(d.title, `YouTube ${vid.videoId}`), observedAt: ts(d.createdAt), versionRef: ts(d.updatedAt),
      collectionPageId, playlistId, fp: fingerprint(['video', YOUTUBE_ADAPTER_VERSION, vid.videoId, collectionPageId, playlistId]),
    };
    if (!videos.has(vid.videoId)) videos.set(vid.videoId, { videoId: vid.videoId, neurons: [] });
    videos.get(vid.videoId).neurons.push(neuron);
    sourceNeurons.push(neuron);
  }
  // deterministic order everywhere (idempotent runs, stable reports)
  for (const v of videos.values()) v.neurons.sort((a, b) => a.pageId.localeCompare(b.pageId));
  for (const v of videos.values()) {
    // canonical display label = most recently updated neuron (ties: page id)
    const latest = [...v.neurons].sort((a, b) => String(b.versionRef ?? '').localeCompare(String(a.versionRef ?? '')) || a.pageId.localeCompare(b.pageId))[0];
    v.label = latest.label;
  }
  const memberships = { collection: new Set(), playlist: new Set() };
  for (const n of sourceNeurons) {
    if (n.collectionPageId) memberships.collection.add(`${n.videoId}>${n.collectionPageId}`);
    if (n.playlistId) memberships.playlist.add(`${n.videoId}>${n.playlistId}`);
  }
  return {
    videos, collections, playlists, sourceNeurons, skipped,
    counts: {
      sourceVideoNeurons: sourceNeurons.length,
      distinctVideos: videos.size,
      duplicateNeurons: sourceNeurons.length - videos.size,
      collections: collections.size,
      playlists: playlists.size,
      playlistNeurons: [...playlists.values()].reduce((s, p) => s + p.neurons.length, 0),
      collectionMemberships: memberships.collection.size,
      playlistMemberships: memberships.playlist.size,
      collectionMembershipProvenance: sourceNeurons.filter(n => n.collectionPageId).length,
      playlistMembershipProvenance: sourceNeurons.filter(n => n.playlistId).length,
    },
  };
}

export default { YOUTUBE_ADAPTER_ID, YOUTUBE_ADAPTER_VERSION, buildYoutubeLibraryPlan, videoIdFromUrl, videoIdentity, boundedLabel };
