import * as FileSystem from 'expo-file-system/legacy';
import { googleJson } from './googleApi';

const FRAME_FOLDER_NAME = 'Frame Library';

export async function ensureFrameFolder(token) {
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

export async function uploadLocalFileToDrive(token, folderId, localUri, media) {
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

export async function deleteDriveFile(token, driveFileId) {
  if (!driveFileId) return false;
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFileId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  );
  return response.ok || response.status === 404;
}
