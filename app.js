import {
  openDB,
  putRecord,
  getAllRecords,
  getPostsByThread,
  hasMessageHash,
  saveMessageEnvelope,
  pruneExpiredMessages,
  getRecord,
  getDirectMessages,
  conversationIdFor
} from './db.js';
import {
  deriveForumKey,
  derivePairwiseKey,
  decryptMessage,
  encryptMessage,
  generateEphemeralNodeId
} from './crypto.js';
import { buildEnvelope, nextHopEnvelope, pickFanoutPeers, shouldAcceptEnvelope } from './gossip.js';
import { P2PMesh } from './p2p.js';

const REFRESH_NODE_ID_MS = 1000 * 60 * 30;
const FORUM_SECRET = 'meshforum-shared-secret';
const PROFILE_REFRESH_MS = 1000 * 60 * 5;

let db;
let forumKey;
let mesh;
let currentThreadId = null;
let currentNodeId = null;
let selectedChatId = null;
let selfProfile = null;
const pairwiseKeyCache = new Map();

const els = {
  layout: document.querySelector('.layout'),
  mobileMenuBtn: document.getElementById('mobileMenuBtn'),
  mobileNav: document.getElementById('mobileNav'),
  tabForumBtn: document.getElementById('tabForumBtn'),
  tabChatBtn: document.getElementById('tabChatBtn'),
  tabNetworkBtn: document.getElementById('tabNetworkBtn'),

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

  profileForm: document.getElementById('profileForm'),
  profileNameInput: document.getElementById('profileNameInput'),
  myChatIdLabel: document.getElementById('myChatIdLabel'),
  chatContactsList: document.getElementById('chatContactsList'),
  chatMessagesList: document.getElementById('chatMessagesList'),
  chatTitle: document.getElementById('chatTitle'),
  chatForm: document.getElementById('chatForm'),
  chatText: document.getElementById('chatText'),

  createOfferBtn: document.getElementById('createOfferBtn'),
  copyOfferBtn: document.getElementById('copyOfferBtn'),
  offerData: document.getElementById('offerData'),
  remoteData: document.getElementById('remoteData'),
  acceptRemoteBtn: document.getElementById('acceptRemoteBtn')
};

boot().catch((err) => {
  console.error(err);
  alert(`خطا در راه‌اندازی: ${err.message}`);
});

async function boot() {
  await registerServiceWorker();
  db = await openDB();
  forumKey = await deriveForumKey(FORUM_SECRET);
  await pruneExpiredMessages(db);
  currentNodeId = await getOrRotateNodeId();
  selfProfile = await getOrCreateProfile();

  mesh = new P2PMesh({ onMessage: onPeerPacket, onPeerState: renderPeerState });

  renderNodeBadge();
  wireEvents();
  applyMobileTab('forum');
  await Promise.all([renderThreads(), renderContacts()]);
  await publishProfile();

  setInterval(async () => {
    currentNodeId = generateEphemeralNodeId();
    await putRecord(db, 'meta', { key: 'node-id', value: currentNodeId, updatedAt: Date.now() });
    renderNodeBadge();
  }, REFRESH_NODE_ID_MS);

  setInterval(publishProfile, PROFILE_REFRESH_MS);
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

async function getOrCreateProfile() {
  let chatId = (await getRecord(db, 'meta', 'chat-id'))?.value;
  if (!chatId) {
    chatId = generateEphemeralNodeId();
    await putRecord(db, 'meta', { key: 'chat-id', value: chatId, updatedAt: Date.now() });
  }

  const existing = await getRecord(db, 'profiles', chatId);
  if (existing) {
    els.profileNameInput.value = existing.displayName;
    els.myChatIdLabel.textContent = `شناسه چت شما: ${chatId.slice(0, 14)}…`;
    return existing;
  }

  const profile = { chatId, displayName: `کاربر-${chatId.slice(0, 4)}`, updatedAt: Date.now() };
  await putRecord(db, 'profiles', profile);
  els.profileNameInput.value = profile.displayName;
  els.myChatIdLabel.textContent = `شناسه چت شما: ${chatId.slice(0, 14)}…`;
  return profile;
}

function wireEvents() {
  els.mobileMenuBtn.addEventListener('click', () => {
    els.mobileNav.classList.toggle('open');
  });
  els.tabForumBtn.addEventListener('click', () => applyMobileTab('forum'));
  els.tabChatBtn.addEventListener('click', () => applyMobileTab('chat'));
  els.tabNetworkBtn.addEventListener('click', () => applyMobileTab('network'));

  els.newThreadBtn.addEventListener('click', () => els.threadDialog.showModal());

  els.threadDialogForm.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    const title = els.threadTitleInput.value.trim();
    if (!title) return;

    const thread = {
      id: crypto.randomUUID(),
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      authorId: currentNodeId
    };
    await putRecord(db, 'threads', thread);
    els.threadDialog.close();
    els.threadTitleInput.value = '';
    await renderThreads(thread.id);
    await publishEnvelope('thread', thread.id, { kind: 'thread-create', thread });
  });

  els.newPostForm.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    if (!currentThreadId) return;
    const text = els.postText.value.trim();
    if (!text) return;

    const post = {
      id: crypto.randomUUID(),
      threadId: currentThreadId,
      text,
      authorId: currentNodeId,
      createdAt: Date.now()
    };
    await putRecord(db, 'posts', post);
    els.postText.value = '';
    await renderPosts(currentThreadId);
    await publishEnvelope('post', currentThreadId, { kind: 'post-create', post });
  });

  els.profileForm.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    const displayName = els.profileNameInput.value.trim();
    if (!displayName) return;

    selfProfile.displayName = displayName;
    selfProfile.updatedAt = Date.now();
    await putRecord(db, 'profiles', selfProfile);
    await publishProfile();
    await renderContacts();
  });

  els.chatForm.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    if (!selectedChatId) return;

    const text = els.chatText.value.trim();
    if (!text) return;

    const dm = {
      id: crypto.randomUUID(),
      conversationId: conversationIdFor(selfProfile.chatId, selectedChatId),
      fromChatId: selfProfile.chatId,
      toChatId: selectedChatId,
      senderName: selfProfile.displayName,
      text,
      createdAt: Date.now()
    };

    await putRecord(db, 'directMessages', dm);
    els.chatText.value = '';
    await renderChatMessages();

    await publishDirectMessage(dm);
  });

  els.createOfferBtn.addEventListener('click', async () => {
    const payload = await mesh.createInvite();
    els.offerData.value = payload;
  });

  els.copyOfferBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(els.offerData.value || '');
  });

  els.acceptRemoteBtn.addEventListener('click', async () => {
    const text = els.remoteData.value.trim();
    if (!text) return;
    const responsePayload = await mesh.acceptPayload(text);
    if (responsePayload) {
      els.offerData.value = responsePayload;
      await navigator.clipboard.writeText(responsePayload);
    }
    els.remoteData.value = '';
  });
}

function applyMobileTab(tab) {
  els.layout.classList.remove('mobile-forum', 'mobile-chat', 'mobile-network');
  els.layout.classList.add(`mobile-${tab}`);
  els.tabForumBtn.classList.toggle('active', tab === 'forum');
  els.tabChatBtn.classList.toggle('active', tab === 'chat');
  els.tabNetworkBtn.classList.toggle('active', tab === 'network');
  els.mobileNav.classList.remove('open');
}

async function renderThreads(selectId = null) {
  const threads = (await getAllRecords(db, 'threads')).sort((a, b) => b.updatedAt - a.updatedAt);
  els.threadsList.innerHTML = '';

  if (!threads.length) {
    const li = document.createElement('li');
    li.className = 'meta';
    li.textContent = 'هنوز موضوعی وجود ندارد.';
    els.threadsList.appendChild(li);
    currentThreadId = null;
    els.activeThreadTitle.textContent = 'یک موضوع انتخاب کنید';
    els.postsList.innerHTML = '';
    els.newPostForm.classList.add('hidden');
    return;
  }

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
  els.activeThreadTitle.textContent = thread ? thread.title : 'موضوع پیدا نشد';
  els.newPostForm.classList.toggle('hidden', !thread);
  els.postsList.innerHTML = '';

  const posts = await getPostsByThread(db, threadId);
  if (!posts.length) {
    const li = document.createElement('li');
    li.className = 'meta';
    li.textContent = 'برای این موضوع هنوز پیامی ثبت نشده است.';
    els.postsList.appendChild(li);
    return;
  }

  for (const post of posts) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="meta">${new Date(post.createdAt).toLocaleString()} • ${post.authorId.slice(0, 8)}…</div><p class="post-text">${escapeHTML(post.text)}</p>`;
    els.postsList.appendChild(li);
  }
}

async function renderContacts() {
  const profiles = (await getAllRecords(db, 'profiles'))
    .filter((p) => p.chatId !== selfProfile.chatId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 100);

  els.chatContactsList.innerHTML = '';
  if (!profiles.length) {
    const li = document.createElement('li');
    li.className = 'meta';
    li.textContent = 'مخاطبی دیده نشده. از بخش شبکه همتا اضافه کنید.';
    els.chatContactsList.appendChild(li);
    return;
  }

  for (const profile of profiles) {
    const li = document.createElement('li');
    li.className = `contact-item ${profile.chatId === selectedChatId ? 'active' : ''}`;
    li.innerHTML = `<strong>${escapeHTML(profile.displayName)}</strong><div class="meta">${profile.chatId.slice(0, 8)}…</div>`;
    li.addEventListener('click', async () => {
      selectedChatId = profile.chatId;
      await renderContacts();
      await renderChatMessages();
    });
    els.chatContactsList.appendChild(li);
  }
}

async function renderChatMessages() {
  if (!selectedChatId) {
    els.chatTitle.textContent = 'یک مخاطب انتخاب کنید';
    els.chatMessagesList.innerHTML = '';
    els.chatForm.classList.add('hidden');
    return;
  }

  const contact = await getRecord(db, 'profiles', selectedChatId);
  const title = contact?.displayName || 'مخاطب ناشناس';
  els.chatTitle.textContent = `چت با ${title}`;
  els.chatForm.classList.remove('hidden');

  const cid = conversationIdFor(selfProfile.chatId, selectedChatId);
  const messages = await getDirectMessages(db, cid);
  els.chatMessagesList.innerHTML = '';

  if (!messages.length) {
    const li = document.createElement('li');
    li.className = 'meta';
    li.textContent = 'هنوز پیامی رد و بدل نشده است.';
    els.chatMessagesList.appendChild(li);
    return;
  }

  for (const msg of messages.slice(-200)) {
    const isMine = msg.fromChatId === selfProfile.chatId;
    const li = document.createElement('li');
    if (isMine) li.classList.add('chat-out');
    li.innerHTML = `<div class="meta">${escapeHTML(msg.senderName)} • ${new Date(msg.createdAt).toLocaleTimeString()}</div><p class="post-text">${escapeHTML(msg.text)}</p>`;
    els.chatMessagesList.appendChild(li);
  }

  els.chatMessagesList.scrollTop = els.chatMessagesList.scrollHeight;
}

async function publishProfile() {
  const profile = { chatId: selfProfile.chatId, displayName: selfProfile.displayName, updatedAt: Date.now() };
  await putRecord(db, 'profiles', profile);
  await publishEnvelope('profile', profile.chatId, { kind: 'profile-announce', profile });
}

async function publishDirectMessage(dm) {
  const pairKey = await getPairwiseKey(dm.fromChatId, dm.toChatId);
  const secureBox = await encryptMessage(pairKey, {
    id: dm.id,
    conversationId: dm.conversationId,
    fromChatId: dm.fromChatId,
    toChatId: dm.toChatId,
    senderName: dm.senderName,
    text: dm.text,
    createdAt: dm.createdAt
  });

  await publishEnvelope('dm', dm.toChatId, {
    kind: 'dm-envelope',
    fromChatId: dm.fromChatId,
    toChatId: dm.toChatId,
    secureBox
  });
}

async function getPairwiseKey(idA, idB) {
  const cacheKey = conversationIdFor(idA, idB);
  if (!pairwiseKeyCache.has(cacheKey)) {
    pairwiseKeyCache.set(cacheKey, derivePairwiseKey(FORUM_SECRET, idA, idB));
  }
  return pairwiseKeyCache.get(cacheKey);
}

async function publishEnvelope(topicType, topicId, payload) {
  const encryptedPayload = await encryptMessage(forumKey, payload);
  const envelope = await buildEnvelope({
    topicId: `${topicType}:${topicId}`,
    encryptedPayload,
    authorId: currentNodeId,
    ttl: 6
  });

  await saveMessageEnvelope(db, envelope);
  mesh.broadcast({ kind: 'gossip', envelope }, pickFanoutPeers(mesh.getPeerIds(), 4));
}

async function onPeerPacket(packet) {
  if (packet.kind !== 'gossip') return;
  const envelope = packet.envelope;

  const accepted = await shouldAcceptEnvelope(db, hasMessageHash, saveMessageEnvelope, envelope);
  if (!accepted) return;

  const payload = await decryptMessage(forumKey, envelope.encryptedPayload);
  await applyPayload(payload);

  if (envelope.ttl > 0) {
    mesh.broadcast({ kind: 'gossip', envelope: nextHopEnvelope(envelope) }, pickFanoutPeers(mesh.getPeerIds(), 4));
  }
}

async function applyPayload(payload) {
  if (payload.kind === 'thread-create') {
    await putRecord(db, 'threads', payload.thread);
    await renderThreads();
    return;
  }

  if (payload.kind === 'post-create') {
    await putRecord(db, 'posts', payload.post);
    const thread = await getRecord(db, 'threads', payload.post.threadId);
    if (thread) {
      thread.updatedAt = Date.now();
      await putRecord(db, 'threads', thread);
    }
    if (currentThreadId === payload.post.threadId) await renderPosts(currentThreadId);
    await renderThreads();
    return;
  }

  if (payload.kind === 'profile-announce') {
    const incoming = payload.profile;
    if (!incoming?.chatId || !incoming?.displayName) return;
    const current = await getRecord(db, 'profiles', incoming.chatId);
    if (!current || (incoming.updatedAt || 0) >= (current.updatedAt || 0)) {
      await putRecord(db, 'profiles', incoming);
      await renderContacts();
      if (selectedChatId === incoming.chatId) await renderChatMessages();
    }
    return;
  }

  if (payload.kind === 'dm-envelope') {
    if (!selfProfile?.chatId) return;
    const { fromChatId, toChatId, secureBox } = payload;
    if (!fromChatId || !toChatId || !secureBox) return;
    if (![fromChatId, toChatId].includes(selfProfile.chatId)) return;

    try {
      const pairKey = await getPairwiseKey(fromChatId, toChatId);
      const dm = await decryptMessage(pairKey, secureBox);
      await putRecord(db, 'directMessages', dm);
      if (selectedChatId && [fromChatId, toChatId].includes(selectedChatId)) {
        await renderChatMessages();
      }
    } catch {
      // پیام نامعتبر یا غیرقابل‌رمزگشایی
    }
  }
}

function renderNodeBadge() {
  els.nodeBadge.textContent = `گره: ${currentNodeId.slice(0, 10)}…`;
}

function renderPeerState(peerIds) {
  els.peerBadge.textContent = `همتاها: ${peerIds.length}`;
  els.peerList.innerHTML = '';

  for (const id of peerIds) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="meta">${id.slice(0, 12)}…</span>`;
    els.peerList.appendChild(li);
  }
}

function escapeHTML(s) {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
