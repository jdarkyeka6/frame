import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import App from './App';
import {
  deleteFrameDriveCopy,
  importGooglePhotosToDrive,
  isGoogleDriveConfigured,
} from './googleDrive';
import { importGoogleDriveLibrary } from './googleDriveImport';

const STORAGE_KEY = 'frame.library.v2';
const LEGACY_STORAGE_KEY = 'frame.library.v1';
const GOOGLE_BATCH_LIMIT = 2000;

function parseLibrary(raw) {
  try {
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export default function FrameRoot() {
  const [appRevision, setAppRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [busyTitle, setBusyTitle] = useState('Importing');
  const [busyNote, setBusyNote] = useState('');
  const [progress, setProgress] = useState('');
  const photosImportHandlerRef = useRef(null);
  const driveImportHandlerRef = useRef(null);
  const busyRef = useRef(false);
  const batchNumberRef = useRef(0);
  const bulkImportedRef = useRef(0);

  function beginBusy(title, note, message) {
    busyRef.current = true;
    setBusyTitle(title);
    setBusyNote(note);
    setProgress(message || 'Preparing…');
    setBusy(true);
  }

  function endBusy() {
    busyRef.current = false;
    setBusy(false);
    setProgress('');
  }

  async function runGoogleBatch() {
    if (busyRef.current) return;
    if (!isGoogleDriveConfigured()) {
      Alert.alert(
        'Google Photos setup needed',
        'This build does not have Frame’s Google OAuth client ID yet. Google sign-in must be connected to this iOS build first.',
      );
      return;
    }

    beginBusy(
      'Importing Google Photos batch',
      'Google caps each picker session at 2,000 items. Frame saves each batch to Drive, keeps small previews on this iPhone, and can immediately start another batch.',
      `Opening Google Photos batch ${batchNumberRef.current + 1}…`,
    );

    let result = null;
    let failure = null;

    try {
      const imported = await importGooglePhotosToDrive((status) => {
        if (status?.message) setProgress(status.message);
      });

      if (!imported.length) {
        result = { selected: 0, fresh: 0, duplicates: 0 };
      } else {
        const currentRaw = await AsyncStorage.getItem(STORAGE_KEY)
          || await AsyncStorage.getItem(LEGACY_STORAGE_KEY);
        const current = parseLibrary(currentRaw);
        const existingGoogleIds = new Set(
          current.map((item) => item.googlePhotosId).filter(Boolean),
        );

        const fresh = [];
        const duplicates = [];
        for (const item of imported) {
          if (item.googlePhotosId && existingGoogleIds.has(item.googlePhotosId)) {
            duplicates.push(item);
          } else {
            fresh.push(item);
            if (item.googlePhotosId) existingGoogleIds.add(item.googlePhotosId);
          }
        }

        for (const duplicate of duplicates) {
          await deleteFrameDriveCopy(duplicate).catch(() => false);
        }

        if (fresh.length) {
          await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(fresh.concat(current)));
          setAppRevision((value) => value + 1);
        }

        batchNumberRef.current += 1;
        bulkImportedRef.current += fresh.length;
        result = {
          selected: imported.length,
          fresh: fresh.length,
          duplicates: duplicates.length,
        };
      }
    } catch (error) {
      failure = error;
    } finally {
      endBusy();
    }

    if (failure) {
      Alert.alert(
        'Google Photos import failed',
        failure?.message || 'Frame could not import that batch.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Try again', onPress: () => setTimeout(runGoogleBatch, 150) },
        ],
      );
      return;
    }

    if (!result?.selected) {
      Alert.alert(
        'No photos selected',
        bulkImportedRef.current
          ? `${bulkImportedRef.current} photo${bulkImportedRef.current === 1 ? '' : 's'} imported in this bulk session.`
          : 'Nothing was imported.',
      );
      return;
    }

    const duplicateText = result.duplicates
      ? ` ${result.duplicates} duplicate${result.duplicates === 1 ? '' : 's'} skipped.`
      : '';

    Alert.alert(
      `Batch ${batchNumberRef.current} imported`,
      `${result.fresh} new photo${result.fresh === 1 ? '' : 's'} saved to Frame.${duplicateText}\n\nTotal this session: ${bulkImportedRef.current}. Google allows up to ${GOOGLE_BATCH_LIMIT.toLocaleString()} per picker session, so Frame can open the next batch immediately.`,
      [
        { text: 'Done', style: 'cancel' },
        { text: 'Import next batch', onPress: () => setTimeout(runGoogleBatch, 150) },
      ],
    );
  }

  function startGoogleBulkImport() {
    if (busyRef.current) return;
    if (!isGoogleDriveConfigured()) {
      Alert.alert(
        'Google Photos setup needed',
        'This build does not have Frame’s Google OAuth client ID yet. Google sign-in must be connected to this iOS build first.',
      );
      return;
    }

    batchNumberRef.current = 0;
    bulkImportedRef.current = 0;

    Alert.alert(
      'Bulk import from Google Photos',
      `Google caps each Photos Picker session at ${GOOGLE_BATCH_LIMIT.toLocaleString()} items. Frame cannot override that Google limit, so Frame will save each batch to Drive, skip duplicates, and then offer the next batch automatically.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Start batch 1', onPress: () => setTimeout(runGoogleBatch, 150) },
      ],
    );
  }

  async function runDriveImport() {
    if (busyRef.current) return;
    if (!isGoogleDriveConfigured()) {
      Alert.alert(
        'Google Drive setup needed',
        'This build does not have Frame’s Google OAuth client ID yet.',
      );
      return;
    }

    beginBusy(
      'Importing from Google Drive',
      'Frame scans Drive for photos, videos and ZIP archives. Normal files are copied into Frame’s Drive folder. ZIPs are downloaded and unpacked one archive at a time, then their media is saved to Frame. Source files are never deleted.',
      'Connecting to Google Drive…',
    );

    let result = null;
    let failure = null;

    try {
      const currentRaw = await AsyncStorage.getItem(STORAGE_KEY)
        || await AsyncStorage.getItem(LEGACY_STORAGE_KEY);
      const current = parseLibrary(currentRaw);
      const existingSourceKeys = current.map((item) => item.sourceKey).filter(Boolean);

      result = await importGoogleDriveLibrary(existingSourceKeys, (status) => {
        if (status?.message) setProgress(status.message);
      });

      if (result.imported.length) {
        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify(result.imported.concat(current)),
        );
        setAppRevision((value) => value + 1);
      }
    } catch (error) {
      failure = error;
    } finally {
      endBusy();
    }

    if (failure) {
      Alert.alert(
        'Google Drive import failed',
        failure?.message || 'Frame could not finish the Drive import.',
      );
      return;
    }

    if (!result?.candidates) {
      Alert.alert(
        'Nothing to import',
        'Frame did not find any photos, videos, or ZIP archives in this Google Drive.',
      );
      return;
    }

    Alert.alert(
      'Drive import finished',
      result.imported.length
        ? `${result.imported.length.toLocaleString()} new photo/video${result.imported.length === 1 ? '' : 's'} added to Frame.${result.skipped ? ` ${result.skipped.toLocaleString()} already-imported item${result.skipped === 1 ? '' : 's'} skipped.` : ''}\n\nYour original Drive files and ZIPs were not changed.`
        : `No new photos or videos were added. ${result.skipped.toLocaleString()} already-imported item${result.skipped === 1 ? '' : 's'} skipped.`,
    );
  }

  function startDriveImport() {
    if (busyRef.current) return;
    Alert.alert(
      'Import everything from Google Drive',
      'Frame will scan your Drive for normal photos/videos and ZIP archives, including Google Takeout ZIPs. ZIPs are processed one at a time so Frame does not keep the whole export on your iPhone. Originals stay untouched.\n\nThe first run may take a long time for a large library.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Import everything', onPress: () => setTimeout(runDriveImport, 150) },
      ],
    );
  }

  photosImportHandlerRef.current = startGoogleBulkImport;
  driveImportHandlerRef.current = startDriveImport;

  useEffect(() => {
    const originalAlert = Alert.alert;
    const originalSetItem = AsyncStorage.setItem.bind(AsyncStorage);
    const originalGetItem = AsyncStorage.getItem.bind(AsyncStorage);

    Alert.alert = (title, message, buttons, options) => {
      if (title === 'Import photos' && Array.isArray(buttons)) {
        const nextButtons = buttons.slice();
        const hasPhotos = nextButtons.some((button) =>
          String(button?.text || '').startsWith('Google Photos'),
        );
        const hasDrive = nextButtons.some((button) =>
          String(button?.text || '').startsWith('Google Drive'),
        );

        const additions = [];
        if (!hasPhotos) {
          additions.push({
            text: 'Google Photos • 2,000 batches',
            onPress: () => photosImportHandlerRef.current?.(),
          });
        }
        if (!hasDrive) {
          additions.push({
            text: 'Google Drive / Takeout • import all',
            onPress: () => driveImportHandlerRef.current?.(),
          });
        }

        const cancelIndex = nextButtons.findIndex((button) => button?.style === 'cancel');
        if (cancelIndex >= 0) nextButtons.splice(cancelIndex, 0, ...additions);
        else nextButtons.push(...additions);
        return originalAlert.call(Alert, title, message, nextButtons, options);
      }
      return originalAlert.call(Alert, title, message, buttons, options);
    };

    AsyncStorage.setItem = async (key, value, ...rest) => {
      let removedCloudItems = [];
      if (key === STORAGE_KEY) {
        try {
          const previous = parseLibrary(await originalGetItem(STORAGE_KEY));
          const next = parseLibrary(value);
          const nextIds = new Set(next.map((item) => item.id));
          removedCloudItems = previous.filter(
            (item) => item?.driveFileId && !nextIds.has(item.id),
          );
        } catch {
          removedCloudItems = [];
        }
      }

      const result = await originalSetItem(key, value, ...rest);
      if (removedCloudItems.length) {
        Promise.all(
          removedCloudItems.map((item) => deleteFrameDriveCopy(item).catch(() => false)),
        ).catch(() => {});
      }
      return result;
    };

    return () => {
      Alert.alert = originalAlert;
      AsyncStorage.setItem = originalSetItem;
    };
  }, []);

  return (
    <View style={styles.root}>
      <App key={appRevision} />
      {busy && (
        <View style={styles.blocker}>
          <View style={styles.panel}>
            <ActivityIndicator size="large" color="#FFFFFF" />
            <Text style={styles.title}>{busyTitle}</Text>
            <Text style={styles.body}>{progress || 'Preparing…'}</Text>
            {!!busyNote && <Text style={styles.note}>{busyNote}</Text>}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0B0B0C' },
  blocker: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    backgroundColor: 'rgba(0,0,0,0.78)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  panel: {
    width: '100%',
    maxWidth: 380,
    borderRadius: 24,
    padding: 24,
    backgroundColor: '#171719',
    borderWidth: 1,
    borderColor: '#2B2B30',
    alignItems: 'center',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '800',
    marginTop: 18,
    textAlign: 'center',
  },
  body: {
    color: '#D7D7DE',
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
  note: {
    color: '#8E8E98',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 14,
    textAlign: 'center',
  },
});
