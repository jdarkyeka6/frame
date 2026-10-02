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
  const [progress, setProgress] = useState('');
  const importHandlerRef = useRef(null);
  const busyRef = useRef(false);
  const batchNumberRef = useRef(0);
  const bulkImportedRef = useRef(0);

  async function runGoogleBatch() {
    if (busyRef.current) return;
    if (!isGoogleDriveConfigured()) {
      Alert.alert(
        'Google Photos setup needed',
        'This build does not have Frame’s Google OAuth client ID yet. Google sign-in must be connected to this iOS build first.',
      );
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setProgress(`Opening Google Photos batch ${batchNumberRef.current + 1}…`);

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
      busyRef.current = false;
      setBusy(false);
      setProgress('');
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

  importHandlerRef.current = startGoogleBulkImport;

  useEffect(() => {
    const originalAlert = Alert.alert;
    const originalSetItem = AsyncStorage.setItem.bind(AsyncStorage);
    const originalGetItem = AsyncStorage.getItem.bind(AsyncStorage);

    Alert.alert = (title, message, buttons, options) => {
      if (title === 'Import photos' && Array.isArray(buttons)) {
        const nextButtons = buttons.slice();
        const alreadyAdded = nextButtons.some((button) =>
          String(button?.text || '').startsWith('Google Photos'),
        );
        if (!alreadyAdded) {
          const googleButton = {
            text: 'Google Photos • bulk batches',
            onPress: () => importHandlerRef.current?.(),
          };
          const cancelIndex = nextButtons.findIndex((button) => button?.style === 'cancel');
          if (cancelIndex >= 0) nextButtons.splice(cancelIndex, 0, googleButton);
          else nextButtons.push(googleButton);
        }
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
            <Text style={styles.title}>Importing Google Photos batch</Text>
            <Text style={styles.body}>{progress || 'Preparing Frame Drive…'}</Text>
            <Text style={styles.note}>
              Google caps each picker session at 2,000 items. Frame saves the batch to Drive, keeps only small previews on this iPhone, and can immediately start another batch when it finishes.
            </Text>
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
