import * as AuthSession from 'expo-auth-session';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_TOKEN_KEY = 'frame.google.token.v1';
const FRAME_FOLDER_NAME = 'Frame Library';
const THUMB_DIR = FileSystem.documentDirectory + 'frame-cloud-thumbs/';
const TEMP_DIR = FileSystem.cacheDirectory + 'frame-google-import/';

const GOOGLE_SCOPES = [
  'openid',
  'profile',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
];

const DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

function googleClientId() {
  return String(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || '').trim();
}

export function isGoogleDriveConfigured() {
  return !!googleClientId();
}

async function ensureDirectory(uri) {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
}

async function saveToken(token, previousRefreshToken = null) {
  const payload = {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken || previousRefreshToken || null,
    expiresIn: Number(token.expiresIn || 3600),
    issuedAt: Number(token.issuedAt || Math.floor(Date.now() / 1000)),
  };
  await SecureStore.setItemAsync(GOOGLE_TOKEN_KEY, JSON.stringify(payload));
  return payload;
}

async function readStoredToken() {
  try {
    const raw = await SecureStore.getItemAsync(GOOGLE_TOKEN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function tokenIsFresh(token) {
  if (!token?.accessToken) return false;
  const issuedAtMs = Number(token.issuedAt || 0) * 1000;
  const expiresMs = Number(token.expiresIn || 0) * 1000;
  return issuedAtMs + expiresMs - 60_000 > Date.now();
}

async function refreshStoredToken(stored) {
  if (!stored?.refreshToken) return null;
  try {
    const refreshed = await AuthSession.refreshAsync(
      {
        clientId: googleClientId(),
        refreshToken: stored.refreshToken,
        scopes: GOOGLE_SCOPES,
      },
      DISCOVERY,
    );
    return saveToken(refreshed, stored.refreshToken);
  } catch {
    return null;
  }
}

async function interactiveGoogleSignIn() {
  const clientId = googleClientId();
  if (!clientId) {
    throw new Error('Google connection is not configured for this build yet.');
  }

  const redirectUri = AuthSession.makeRedirectUri({
    scheme: 'frame',
    path: 'google-auth',
  });

  const request = new AuthSession.AuthRequest({
    clientId,
    redirectUri,
    responseType: AuthSession.ResponseType.Code,
    scopes: GOOGLE_SCOPES,
    usePKCE: true,
    extraParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
  });

  const result = await request.promptAsync(DISCOVERY);
  if (result.type !== 'success' || !result.params?.code) {
    if (result.type === 'cancel' || result.type === 'dismiss') return null;
    throw new Error(result?.error?.message || 'Google sign-in did not finish.');
  }

  const token = await AuthSession.exchangeCodeAsync(
    {
      clientId,
      code: result.params.code,
      redirectUri,
      extraParams: request.codeVerifier
        ? { code_verifier: request.codeVerifier }
        : undefined,
    },
    DISCOVERY,
  );

  return saveToken(token);
}

export async function getGoogleAccessToken({ interactive = true } = {}) {
  const stored = await readStoredToken();
  if (tokenIsFresh(stored)) return stored.accessToken;

  const refreshed = await refreshStoredToken(stored);
  if (refreshed?.accessToken) return refreshed.accessToken;

  if (!interactive) return null;
  const signedIn = await interactiveGoogleSignIn();
  return signedIn?.accessToken || null;
}

async function googleJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Google request failed (${response.status}).`);
  }
  return payload;
}

async function ensureFrameFolder(token) {
  const q = encodeURIComponent(
    "mimeType = 'application/vnd.google-apps.folder' and name = 'Frame Library' and trashed = false and appProperties has { key='frameManaged' and value='true' }",
  );
  const found = await googleJson(
    `https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1&q=${q}&fields=files(id,name)`,
    token,
  );
  if (found?.files?.[0]?.id) return found.files[0].id;

  const created = await googleJson(
    'https://www.googleapis.com/drive/v3/files?fields=id,name',
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: FRAME_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: { frameManaged: 'true' },
      }),
    },
  );
  return created.id;
}

async function createPickerSession(token) {
  return googleJson('https://photospicker.googleapis.com/v1/sessions', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pickingConfig: { maxItemCount: '2000' } }),
  });
}

function durationMs(value, fallback) {
  const parsed = Number.parseFloat(String(value || '').replace('s', ''));
  return Number.isFinite(parsed) ? Math.max(250, parsed * 1000) : fallback;
}

async function waitForPicker(token, session) {
  let current = session;
  const started = Date.now();

  while (!current?.mediaItemsSet) {
    const timeout = durationMs(current?.pollingConfig?.timeoutIn, 120_000);
    if (Date.now() - started > Math.max(timeout, 30_000)) {
      throw new Error('Google Photos selection timed out.');
    }
    const delay = Math.min(durationMs(current?.pollingConfig?.pollInterval, 1500), 5000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    current = await googleJson(
      `https://photospicker.googleapis.com/v1/sessions/${encodeURIComponent(session.id)}`,
      token,
    );
  }
  return current;
}

async function listPickedMedia(token, sessionId) {
  const result = [];
  let pageToken = '';
  do {
    const query = new URLSearchParams({ sessionId, pageSize: '100' });
    if (pageToken) query.set('pageToken', pageToken);
    const page = await googleJson(
      `https://photospicker.googleapis.com/v1/mediaItems?${query.toString()}`,
      token,
    );
    result.push(...(page.mediaItems || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return result;
}

function safeExtension(filename, mimeType) {
  const match = String(filename || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  if (match) return match[1];
  if (String(mimeType).includes('png')) return 'png';
  if (String(mimeType).includes('heic')) return 'heic';
  if (String(mimeType).includes('gif')) return 'gif';
  if (String(mimeType).includes('video')) return 'mp4';
  return 'jpg';
}

async function uploadLocalFileToDrive(token, folderId, localUri, media) {
  const file = media.mediaFile || {};
  const created = await googleJson(
    'https://www.googleapis.com/drive/v3/files?fields=id,name,size',
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: file.filename || `Google Photo ${media.id}`,
        mimeType: file.mimeType || 'application/octet-stream',
        parents: [folderId],
        appProperties: {
          frameManaged: 'true',
          frameSource: 'googlePhotos',
          googlePhotosId: String(media.id),
        },
      }),
    },
  );

  try {
    const upload = await FileSystem.uploadAsync(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(created.id)}?uploadType=media&fields=id,size`,
      localUri,
      {
        httpMethod: 'PATCH',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': file.mimeType || 'application/octet-stream',
        },
      },
    );
    if (upload.status < 200 || upload.status >= 300) {
      throw new Error(`Google Drive upload failed (${upload.status}).`);
    }
  } catch (error) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(created.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
    throw error;
  }

  return created.id;
}

async function importOneMedia(token, folderId, media, index) {
  const file = media.mediaFile || {};
  const metadata = file.mediaFileMetadata || {};
  const isVideo = media.type === 'VIDEO' || String(file.mimeType || '').startsWith('video/');
  const extension = safeExtension(file.filename, file.mimeType);
  const unique = `${Date.now()}-${index}-${String(media.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(-24)}`;
  const originalUri = `${TEMP_DIR}${unique}.${extension}`;
  const thumbUri = `${THUMB_DIR}${unique}.jpg`;
  const originalUrl = `${file.baseUrl}${isVideo ? '=dv' : '=d'}`;
  const thumbUrl = `${file.baseUrl}=w512-h512${isVideo ? '-no' : ''}`;
  const headers = { Authorization: `Bearer ${token}` };

  await FileSystem.downloadAsync(thumbUrl, thumbUri, { headers });
  await FileSystem.downloadAsync(originalUrl, originalUri, { headers });

  try {
    const info = await FileSystem.getInfoAsync(originalUri);
    const driveFileId = await uploadLocalFileToDrive(token, folderId, originalUri, media);
    const now = Date.now();
    return {
      id: `google-${media.id}`,
      uri: thumbUri,
      name: file.filename || `Google Photo ${index + 1}`,
      mimeType: file.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg'),
      size: info?.size || null,
      width: metadata.width || null,
      height: metadata.height || null,
      importedAt: now + index,
      favorite: false,
      reviewed: false,
      reviewedAt: null,
      deletedAt: null,
      source: 'google-photos-drive',
      googlePhotosId: media.id,
      driveFileId,
      cloudBacked: true,
      albumIds: [],
    };
  } finally {
    await FileSystem.deleteAsync(originalUri, { idempotent: true }).catch(() => {});
  }
}

export async function importGooglePhotosToDrive(onProgress) {
  const token = await getGoogleAccessToken({ interactive: true });
  if (!token) return [];

  await ensureDirectory(THUMB_DIR);
  await ensureDirectory(TEMP_DIR);

  const session = await createPickerSession(token);
  if (!session?.id || !session?.pickerUri) throw new Error('Google Photos could not start a picker session.');

  try {
    onProgress?.({ phase: 'pick', message: 'Choose photos in Google Photos' });
    await WebBrowser.openBrowserAsync(session.pickerUri);

    onProgress?.({ phase: 'waiting', message: 'Reading your selection…' });
    await waitForPicker(token, session);
    const picked = await listPickedMedia(token, session.id);
    if (!picked.length) return [];

    const folderId = await ensureFrameFolder(token);
    const imported = [];

    for (let i = 0; i < picked.length; i += 1) {
      onProgress?.({
        phase: 'upload',
        current: i + 1,
        total: picked.length,
        message: `Saving ${i + 1} of ${picked.length} to Frame Drive…`,
      });
      imported.push(await importOneMedia(token, folderId, picked[i], i));
    }

    return imported;
  } finally {
    await fetch(
      `https://photospicker.googleapis.com/v1/sessions/${encodeURIComponent(session.id)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    ).catch(() => {});
  }
}

export async function deleteFrameDriveCopy(item) {
  if (!item?.driveFileId) return false;
  const token = await getGoogleAccessToken({ interactive: false });
  if (!token) return false;

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(item.driveFileId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  );
  return response.ok || response.status === 404;
}
