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

export async function uploadFrameFileToDrive(
  token,
  folderId,
  localUri,
  { name, mimeType = 'application/octet-stream', source = 'drive', sourceId = '' } = {},
) {
  const created = await googleJson(
    'https://www.googleapis.com/drive/v3/files?fields=id,name,size,mimeType',
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name || `Frame import ${Date.now()}`,
        mimeType,
        parents: [folderId],
        appProperties: {
          frameManaged: 'true',
          frameSource: String(source || 'drive').slice(0, 120),
          frameSourceId: String(sourceId || '').slice(0, 120),
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
          'Content-Type': mimeType,
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

export async function uploadLocalFileToDrive(token, folderId, localUri, media) {
  const file = media.mediaFile || {};
  return uploadFrameFileToDrive(token, folderId, localUri, {
    name: file.filename || `Google Photo ${media.id}`,
    mimeType: file.mimeType || 'application/octet-stream',
    source: 'googlePhotos',
    sourceId: String(media.id),
  });
}

export async function copyDriveFileToFrame(token, folderId, sourceFile) {
  return googleJson(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sourceFile.id)}/copy?fields=id,name,size,mimeType`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: sourceFile.name,
        parents: [folderId],
        appProperties: {
          frameManaged: 'true',
          frameSource: 'googleDrive',
          frameSourceId: String(sourceFile.id),
        },
      }),
    },
  );
}

export async function downloadDriveFile(token, driveFileId, destinationUri) {
  const result = await FileSystem.downloadAsync(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFileId)}?alt=media`,
    destinationUri,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Google Drive download failed (${result.status}).`);
  }
  return result.uri;
}

export async function downloadDriveThumbnail(token, driveFileId, destinationUri) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const metadata = await googleJson(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFileId)}?fields=thumbnailLink`,
      token,
    ).catch(() => null);
    if (metadata?.thumbnailLink) {
      const result = await FileSystem.downloadAsync(metadata.thumbnailLink, destinationUri, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
      if (result && result.status >= 200 && result.status < 300) return result.uri;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
  }
  return null;
}

export async function deleteDriveFile(token, driveFileId) {
  if (!driveFileId) return false;
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFileId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  );
  return response.ok || response.status === 404;
}
