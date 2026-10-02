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

  async function handleGoogleImport() {
    if (busy) return;
    if (!isGoogleDriveConfigured()) {
      Alert.alert(
        'Google Photos setup needed',
        'This build does not have Frame’s Google OAuth client ID yet. The app code is ready, but Google sign-in must be connected to this iOS build first.',
      );
      return;
    }

    setBusy(true);
    setProgress('Connecting to Google…');

    try {
      const imported = await importGooglePhotosToDrive((status) => {
        if (status?.message) setProgress(status.message);
      });
      if (!imported.length) return;

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

      Alert.alert(
        'Google Photos imported',
        fresh.length
          ? `${fresh.length} item${fresh.length === 1 ? '' : 's'} saved to Frame. Originals in Google Photos were not changed.`
          : 'Those photos are already in Frame. Your Google Photos originals were not changed.',
      );
    } catch (error) {
      Alert.alert('Google Photos import failed', error?.message || 'Frame could not import those photos.');
    } finally {
      setBusy(false);
      setProgress('');
    }
  }

  importHandlerRef.current = handleGoogleImport;

  useEffect(() => {
    const originalAlert = Alert.alert;
    const originalSetItem = AsyncStorage.setItem.bind(AsyncStorage);
    const originalGetItem = AsyncStorage.getItem.bind(AsyncStorage);

    Alert.alert = (title, message, buttons, options) => {
      if (title === 'Import photos' && Array.isArray(buttons)) {
        const nextButtons = buttons.slice();
        const alreadyAdded = nextButtons.some((button) => button?.text === 'Google Photos');
        if (!alreadyAdded) {
          const googleButton = {
            text: 'Google Photos',
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
            <Text style={styles.title}>Importing from Google Photos</Text>
            <Text style={styles.body}>{progress || 'Preparing Frame Drive…'}</Text>
            <Text style={styles.note}>
              Frame only keeps a small preview on this iPhone. Full originals are copied to Frame’s folder in Google Drive one at a time.
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
