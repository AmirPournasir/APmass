const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function generateEphemeralNodeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function deriveForumKey(passphrase) {
  const salt = textEncoder.encode('meshforum-e2e-salt-v1');
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 150000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptMessage(key, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = textEncoder.encode(JSON.stringify(payload));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    iv: bufferToBase64(iv),
    cipher: bufferToBase64(new Uint8Array(cipher))
  };
}

export async function decryptMessage(key, encryptedPayload) {
  const iv = base64ToBuffer(encryptedPayload.iv);
  const cipher = base64ToBuffer(encryptedPayload.cipher);
  const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return JSON.parse(textDecoder.decode(plainBuffer));
}

export async function sha256Hex(data) {
  const source = typeof data === 'string' ? textEncoder.encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', source);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function bufferToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

export function base64ToBuffer(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
