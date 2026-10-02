import * as FileSystem from 'expo-file-system/legacy';
import { getGoogleAccessToken, isGoogleOAuthConfigured } from './googleAuth';
import { deleteDriveFile, ensureFrameFolder, uploadLocalFileToDrive } from './googleDriveStorage';
import { pickGooglePhotos } from './googlePhotosPicker';

const THUMB_DIR = FileSystem.documentDirectory + 'frame-cloud-thumbs/';
const TEMP_DIR = FileSystem.cacheDirectory + 'frame-google-import/';

async function ensureDirectory(uri) {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
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

async function importOneMedia(token, folderId, media, index) {
  const file = media.mediaFile || {};
  const metadata = file.mediaFileMetadata || {};
  if (!file.baseUrl) throw new Error('Google Photos did not provide a download URL for this item.');

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

export function isGoogleDriveConfigured() {
  return isGoogleOAuthConfigured();
}

export async function importGooglePhotosToDrive(onProgress) {
  const token = await getGoogleAccessToken({ interactive: true });
  if (!token) return [];

  await ensureDirectory(THUMB_DIR);
  await ensureDirectory(TEMP_DIR);

  const picked = await pickGooglePhotos(token, onProgress);
  if (!picked.length) return [];

  const folderId = await ensureFrameFolder(token);
  const imported = [];
  let lastError = null;

  for (let i = 0; i < picked.length; i += 1) {
    onProgress?.({
      phase: 'upload',
      current: i + 1,
      total: picked.length,
      message: `Saving ${i + 1} of ${picked.length} to Frame Drive…`,
    });

    try {
      imported.push(await importOneMedia(token, folderId, picked[i], i));
    } catch (error) {
      lastError = error;
    }
  }

  if (!imported.length && lastError) throw lastError;
  return imported;
}

export async function deleteFrameDriveCopy(item) {
  if (!item?.driveFileId) return false;
  const token = await getGoogleAccessToken({ interactive: false });
  if (!token) return false;
  return deleteDriveFile(token, item.driveFileId);
}
