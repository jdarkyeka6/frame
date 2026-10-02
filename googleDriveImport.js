import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { unzip } from 'react-native-zip-archive';
import { googleJson } from './googleApi';
import { getGoogleAccessToken } from './googleAuth';
import {
  copyDriveFileToFrame,
  downloadDriveFile,
  downloadDriveThumbnail,
  ensureFrameFolder,
  uploadFrameFileToDrive,
} from './googleDriveStorage';

const TEMP_ROOT = FileSystem.cacheDirectory + 'frame-drive-import/';
const THUMB_ROOT = FileSystem.documentDirectory + 'frame-cloud-thumbs/';

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'heic', 'heif', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'dng',
]);
const VIDEO_EXTENSIONS = new Set([
  'mp4', 'mov', 'm4v', '3gp', 'avi', 'mkv', 'webm',
]);

function extension(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function isZip(file) {
  const mime = String(file?.mimeType || '').toLowerCase();
  return extension(file?.name) === 'zip'
    || mime === 'application/zip'
    || mime === 'application/x-zip-compressed';
}

function isMediaName(name) {
  const ext = extension(name);
  return IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext);
}

function isMediaFile(file) {
  const mime = String(file?.mimeType || '').toLowerCase();
  return mime.startsWith('image/') || mime.startsWith('video/') || isMediaName(file?.name);
}

function mimeForName(name) {
  const ext = extension(name);
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
    dng: 'image/x-adobe-dng', mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v',
    '3gp': 'video/3gpp', avi: 'video/x-msvideo', mkv: 'video/x-matroska', webm: 'video/webm',
  };
  return map[ext] || 'application/octet-stream';
}

function safePart(value) {
  return String(value || 'item').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
}

async function ensureDirectories() {
  for (const dir of [TEMP_ROOT, THUMB_ROOT]) {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
}

async function listDriveCandidates(token) {
  const files = [];
  let pageToken = '';

  do {
    const query = new URLSearchParams({
      spaces: 'drive',
      pageSize: '1000',
      q: 'trashed = false',
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum,appProperties)',
    });
    if (pageToken) query.set('pageToken', pageToken);

    const page = await googleJson(
      `https://www.googleapis.com/drive/v3/files?${query.toString()}`,
      token,
    );

    for (const file of page.files || []) {
      if (file?.appProperties?.frameManaged === 'true') continue;
      if (isZip(file) || isMediaFile(file)) files.push(file);
    }
    pageToken = page.nextPageToken || '';
  } while (pageToken);

  return files;
}

async function walkDirectory(root, current = root) {
  const output = [];
  const names = await FileSystem.readDirectoryAsync(current);
  for (const name of names) {
    const uri = `${current.replace(/\/$/, '')}/${name}`;
    const info = await FileSystem.getInfoAsync(uri);
    if (info.isDirectory) output.push(...await walkDirectory(root, uri));
    else output.push({ uri, relativePath: uri.slice(root.length).replace(/^\/+/, ''), info });
  }
  return output;
}

async function makeThumb(token, preferredDriveId, fallbackDriveId, key) {
  const uri = `${THUMB_ROOT}${safePart(key)}.jpg`;
  const preferred = preferredDriveId
    ? await downloadDriveThumbnail(token, preferredDriveId, uri).catch(() => null)
    : null;
  if (preferred) return preferred;
  if (fallbackDriveId && fallbackDriveId !== preferredDriveId) {
    return downloadDriveThumbnail(token, fallbackDriveId, uri).catch(() => null);
  }
  return null;
}

async function makeLocalPreview(localUri, name, key) {
  const destination = `${THUMB_ROOT}${safePart(key)}.jpg`;
  await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {});
  let generated = null;

  try {
    if (VIDEO_EXTENSIONS.has(extension(name))) {
      generated = await VideoThumbnails.getThumbnailAsync(localUri, {
        time: 100,
        quality: 0.65,
      });
    } else {
      generated = await ImageManipulator.manipulateAsync(
        localUri,
        [{ resize: { width: 512 } }],
        { compress: 0.72, format: ImageManipulator.SaveFormat.JPEG },
      );
    }

    if (!generated?.uri) return null;
    await FileSystem.copyAsync({ from: generated.uri, to: destination });
    return destination;
  } catch {
    return null;
  } finally {
    if (generated?.uri && generated.uri !== localUri && generated.uri !== destination) {
      await FileSystem.deleteAsync(generated.uri, { idempotent: true }).catch(() => {});
    }
  }
}

async function copyLooseDriveMedia(token, folderId, file, index) {
  const sourceKey = `drive:${file.id}`;
  let copied = null;

  try {
    copied = await copyDriveFileToFrame(token, folderId, file);
  } catch {
    const tempUri = `${TEMP_ROOT}loose-${safePart(file.id)}-${safePart(file.name)}`;
    await downloadDriveFile(token, file.id, tempUri);
    try {
      const driveFileId = await uploadFrameFileToDrive(token, folderId, tempUri, {
        name: file.name,
        mimeType: file.mimeType || mimeForName(file.name),
        source: 'googleDrive',
        sourceId: file.id,
      });
      copied = { id: driveFileId, name: file.name, size: file.size, mimeType: file.mimeType };
    } finally {
      await FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
    }
  }

  const thumb = await makeThumb(token, file.id, copied.id, `drive-${file.id}`);
  return {
    id: `drive-${file.id}`,
    uri: thumb || '',
    name: file.name || `Drive photo ${index + 1}`,
    mimeType: file.mimeType || mimeForName(file.name),
    size: Number(file.size || copied.size || 0) || null,
    width: null,
    height: null,
    importedAt: Date.now() + index,
    favorite: false,
    reviewed: false,
    reviewedAt: null,
    deletedAt: null,
    source: 'google-drive',
    sourceKey,
    sourceHash: file.md5Checksum || null,
    sourceDriveFileId: file.id,
    driveFileId: copied.id,
    cloudBacked: true,
    albumIds: [],
  };
}

async function importZip(token, folderId, archive, existingKeys, onProgress, countOffset) {
  const zipUri = `${TEMP_ROOT}archive-${safePart(archive.id)}.zip`;
  const outputDir = `${TEMP_ROOT}unzipped-${safePart(archive.id)}/`;
  await FileSystem.deleteAsync(outputDir, { idempotent: true }).catch(() => {});
  await FileSystem.makeDirectoryAsync(outputDir, { intermediates: true });

  const imported = [];
  let skipped = 0;

  try {
    onProgress?.({ message: `Downloading ${archive.name}…` });
    await downloadDriveFile(token, archive.id, zipUri);

    onProgress?.({ message: `Unpacking ${archive.name}…` });
    await unzip(zipUri, outputDir);

    const extracted = (await walkDirectory(outputDir)).filter((entry) => isMediaName(entry.relativePath));
    for (let i = 0; i < extracted.length; i += 1) {
      const entry = extracted[i];
      const sourceKey = `drivezip:${archive.id}:${entry.relativePath}`;
      if (existingKeys.has(sourceKey)) {
        skipped += 1;
        continue;
      }

      onProgress?.({
        message: `Importing ${archive.name}: ${i + 1} of ${extracted.length}…`,
        current: countOffset + imported.length + 1,
      });

      try {
        const name = entry.relativePath.split('/').pop() || `Photo ${i + 1}`;
        const mimeType = mimeForName(name);
        const driveFileId = await uploadFrameFileToDrive(token, folderId, entry.uri, {
          name,
          mimeType,
          source: 'googleDriveZip',
          sourceId: `${archive.id}:${entry.relativePath}`,
        });
        const localThumb = await makeLocalPreview(
          entry.uri,
          name,
          `zip-${archive.id}-${safePart(entry.relativePath)}-${i}`,
        );
        const thumb = localThumb || await makeThumb(token, driveFileId, null, `zip-${archive.id}-${i}`);
        const info = await FileSystem.getInfoAsync(entry.uri, { md5: true }).catch(() => entry.info || {});

        imported.push({
          id: `drivezip-${archive.id}-${safePart(entry.relativePath)}-${i}`,
          uri: thumb || '',
          name,
          mimeType,
          size: Number(info?.size || 0) || null,
          width: null,
          height: null,
          importedAt: Date.now() + countOffset + i,
          favorite: false,
          reviewed: false,
          reviewedAt: null,
          deletedAt: null,
          source: 'google-drive-zip',
          sourceKey,
          sourceHash: info?.md5 || null,
          sourceDriveFileId: archive.id,
          sourceArchiveName: archive.name,
          driveFileId,
          cloudBacked: true,
          albumIds: [],
        });
        existingKeys.add(sourceKey);
      } catch {
        // Keep going so one damaged file does not kill a full Takeout archive.
      }
    }
  } finally {
    await FileSystem.deleteAsync(outputDir, { idempotent: true }).catch(() => {});
    await FileSystem.deleteAsync(zipUri, { idempotent: true }).catch(() => {});
  }

  return { imported, skipped };
}

export async function importGoogleDriveLibrary(existingSourceKeys = [], onProgress) {
  const token = await getGoogleAccessToken({ interactive: true });
  if (!token) return { imported: [], skipped: 0, candidates: 0 };

  await ensureDirectories();
  onProgress?.({ message: 'Scanning Google Drive for photos, videos and ZIPs…' });
  const candidates = await listDriveCandidates(token);
  if (!candidates.length) return { imported: [], skipped: 0, candidates: 0 };

  const existingKeys = new Set(existingSourceKeys || []);
  const folderId = await ensureFrameFolder(token);
  const archives = candidates.filter(isZip);
  const loose = candidates.filter((file) => !isZip(file) && isMediaFile(file));
  const imported = [];
  let skipped = 0;

  for (let i = 0; i < loose.length; i += 1) {
    const file = loose[i];
    const sourceKey = `drive:${file.id}`;
    if (existingKeys.has(sourceKey)) {
      skipped += 1;
      continue;
    }

    onProgress?.({
      message: `Importing Drive file ${i + 1} of ${loose.length}…`,
      current: imported.length + 1,
    });

    try {
      const item = await copyLooseDriveMedia(token, folderId, file, imported.length);
      imported.push(item);
      existingKeys.add(sourceKey);
    } catch {
      // Continue with the rest of the Drive library.
    }
  }

  for (let i = 0; i < archives.length; i += 1) {
    onProgress?.({ message: `Takeout ZIP ${i + 1} of ${archives.length}: ${archives[i].name}` });
    try {
      const result = await importZip(
        token,
        folderId,
        archives[i],
        existingKeys,
        onProgress,
        imported.length,
      );
      imported.push(...result.imported);
      skipped += result.skipped;
    } catch {
      // A corrupt/oversized archive should not prevent other archives from importing.
    }
  }

  return { imported, skipped, candidates: candidates.length };
}
