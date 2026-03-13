import {
  openDB,
  putRecord,
  getAllRecords,
  getPostsByThread,
  hasMessageHash,
  saveMessageEnvelope,
  pruneExpiredMessages,
  getRecord
} from './db.js';
import { deriveForumKey, decryptMessage, encryptMessage, generateEphemeralNodeId } from './crypto.js';
import { buildEnvelope, nextHopEnvelope, pickFanoutPeers, shouldAcceptEnvelope } from './gossip.js';
import { P2PMesh } from './p2p.js';

const REFRESH_NODE_ID_MS = 1000 * 60 * 30;
const FORUM_SECRET = 'meshforum-shared-secret';

let db;
let forumKey;
let mesh;
let currentThreadId = null;
let currentNodeId = null;

const els = {
  nodeBadge: document.getElementById('nodeBadge'),
  peerBadge: document.getElementById('peerBadge'),
  peerList: document.getElementById('peerList'),
  threadsList: document.getElementById('threadsList'),
  postsList: document.getElementById('postsList'),
  activeThreadTitle: document.getElementById('activeThreadTitle'),
  newThreadBtn: document.getElementById('newThreadBtn'),
  threadDialog: document.getElementById('threadDialog'),
  threadDialogForm: document.getElementById('threadDialogForm'),
  threadTitleInput: document.getElementById('threadTitleInput'),
  newPostForm: document.getElementById('newPostForm'),
  postText: document.getElementById('postText'),
  createOfferBtn: document.getElementById('createOfferBtn'),
  copyOfferBtn: document.getElementById('copyOfferBtn'),
  offerData: document.getElementById('offerData'),
  remoteData: document.getElementById('remoteData'),
  acceptRemoteBtn: document.getElementById('acceptRemoteBtn')
};

// Boot sequence: cache registration, DB + key initialization, then UI wiring.
boot().catch((err) => {
  console.error(err);
  alert(`Startup error: ${err.message}`);
});

async function boot() {
  await registerServiceWorker();
  db = await openDB();
  forumKey = await deriveForumKey(FORUM_SECRET);
  await pruneExpiredMessages(db);
  currentNodeId = await getOrRotateNodeId();

  mesh = new P2PMesh({
    onMessage: onPeerPacket,
    onPeerState: renderPeerState
  });

  renderNodeBadge();
  wireEvents();
  await renderThreads();

  setInterval(async () => {
    currentNodeId = generateEphemeralNodeId();
    await putRecord(db, 'meta', { key: 'node-id', value: currentNodeId, updatedAt: Date.now() });
    renderNodeBadge();
  }, REFRESH_NODE_ID_MS);
}

async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    await navigator.serviceWorker.register('./service-worker.js');
  }
}

async function getOrRotateNodeId() {
  const meta = await getRecord(db, 'meta', 'node-id');
  if (!meta || Date.now() - (meta.updatedAt || 0) > REFRESH_NODE_ID_MS) {
    const id = generateEphemeralNodeId();
    await putRecord(db, 'meta', { key: 'node-id', value: id, updatedAt: Date.now() });
    return id;
  }
  return meta.value;
}

function wireEvents() {
  els.newThreadBtn.addEventListener('click', () => els.threadDialog.showModal());

  els.threadDialogForm.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    if (!els.threadTitleInput.value.trim()) return;
    const thread = {
      id: crypto.randomUUID(),
      title: els.threadTitleInput.value.trim(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      authorId: currentNodeId
    };
    await putRecord(db, 'threads', thread);
    els.threadDialog.close();
    els.threadTitleInput.value = '';
    await renderThreads(thread.id);

    await publishEnvelope('thread', thread.id, {
      kind: 'thread-create',
      thread
    });
  });

  els.newPostForm.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    if (!currentThreadId || !els.postText.value.trim()) return;

    const post = {
      id: crypto.randomUUID(),
      threadId: currentThreadId,
      text: els.postText.value.trim(),
      authorId: currentNodeId,
      createdAt: Date.now()
    };
    await putRecord(db, 'posts', post);
    els.postText.value = '';
    await renderPosts(currentThreadId);

    await publishEnvelope('post', currentThreadId, {
      kind: 'post-create',
      post
    });
  });

  els.createOfferBtn.addEventListener('click', async () => {
    const payload = await mesh.createInvite();
    els.offerData.value = payload;
  });

  els.copyOfferBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(els.offerData.value || '');
  });

  els.acceptRemoteBtn.addEventListener('click', async () => {
    if (!els.remoteData.value.trim()) return;
    const responsePayload = await mesh.acceptPayload(els.remoteData.value.trim());
    if (responsePayload) {
      els.offerData.value = responsePayload;
      await navigator.clipboard.writeText(responsePayload);
    }
    els.remoteData.value = '';
  });
}

async function renderThreads(selectId = null) {
  const threads = (await getAllRecords(db, 'threads')).sort((a, b) => b.updatedAt - a.updatedAt);
  els.threadsList.innerHTML = '';

  threads.forEach((thread) => {
    const li = document.createElement('li');
    li.className = `thread-item ${thread.id === (selectId || currentThreadId) ? 'active' : ''}`;
    li.innerHTML = `<strong>${escapeHTML(thread.title)}</strong><div class="meta">${new Date(thread.updatedAt).toLocaleString()}</div>`;
    li.addEventListener('click', async () => {
      currentThreadId = thread.id;
      await renderThreads();
      await renderPosts(thread.id);
    });
    els.threadsList.appendChild(li);
  });

  if (selectId) {
    currentThreadId = selectId;
    await renderPosts(selectId);
  }
}

async function renderPosts(threadId) {
  const thread = await getRecord(db, 'threads', threadId);
  els.activeThreadTitle.textContent = thread ? thread.title : 'Thread not found';
  els.newPostForm.classList.toggle('hidden', !thread);
  els.postsList.innerHTML = '';

  const posts = await getPostsByThread(db, threadId);
  posts.forEach((post) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="meta">${new Date(post.createdAt).toLocaleString()} • ${post.authorId.slice(0, 8)}…</div>
      <p class="post-text">${escapeHTML(post.text)}</p>
    `;
    els.postsList.appendChild(li);
  });
}

async function publishEnvelope(topicType, topicId, payload) {
  // All forum data is encrypted locally and only encrypted envelopes are gossiped.
  const encryptedPayload = await encryptMessage(forumKey, payload);
  const envelope = await buildEnvelope({
    topicId: `${topicType}:${topicId}`,
    encryptedPayload,
    authorId: currentNodeId,
    ttl: 6
  });

  await saveMessageEnvelope(db, envelope);
  const peers = mesh.getPeerIds();
  const fanout = pickFanoutPeers(peers, 3);
  mesh.broadcast({ kind: 'gossip', envelope }, fanout);
}

async function onPeerPacket(packet) {
  if (packet.kind !== 'gossip') return;
  const envelope = packet.envelope;

  const accepted = await shouldAcceptEnvelope(db, hasMessageHash, saveMessageEnvelope, envelope);
  if (!accepted) return;

  // Decrypt after dedupe check so we avoid expensive decrypt work for duplicates.
  const payload = await decryptMessage(forumKey, envelope.encryptedPayload);
  await applyPayload(payload);

  if (envelope.ttl > 0) {
    const next = nextHopEnvelope(envelope);
    const targets = pickFanoutPeers(mesh.getPeerIds(), 3);
    mesh.broadcast({ kind: 'gossip', envelope: next }, targets);
  }
}

async function applyPayload(payload) {
  if (payload.kind === 'thread-create') {
    await putRecord(db, 'threads', payload.thread);
    await renderThreads();
  }

  if (payload.kind === 'post-create') {
    await putRecord(db, 'posts', payload.post);
    const thread = await getRecord(db, 'threads', payload.post.threadId);
    if (thread) {
      thread.updatedAt = Date.now();
      await putRecord(db, 'threads', thread);
    }
    if (currentThreadId === payload.post.threadId) {
      await renderPosts(currentThreadId);
    }
    await renderThreads();
  }
}

function renderNodeBadge() {
  els.nodeBadge.textContent = `Node: ${currentNodeId.slice(0, 10)}…`;
}

function renderPeerState(peerIds) {
  els.peerBadge.textContent = `Peers: ${peerIds.length}`;
  els.peerList.innerHTML = '';
  peerIds.forEach((id) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="peer-pill">${id.slice(0, 12)}…</span>`;
    els.peerList.appendChild(li);
  });
}

function escapeHTML(s) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
