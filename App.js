import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  FlatList,
  Modal,
  PanResponder,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';

const COLORS = {
  bg: '#0B0B0C',
  card: '#171719',
  card2: '#202023',
  text: '#FFFFFF',
  muted: '#A6A6AD',
  line: '#2B2B30',
  accent: '#8B7CFF',
  green: '#44D17A',
  red: '#FF5B64',
  yellow: '#FFD45C',
};

const STORAGE_KEY = 'frame.library.v2';
const LEGACY_STORAGE_KEY = 'frame.library.v1';
const ALBUMS_KEY = 'frame.albums.v1';
const MEDIA_DIR = FileSystem.documentDirectory + 'frame-media/';
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const SCREEN = Dimensions.get('window').width;

async function ensureMediaDir() {
  const info = await FileSystem.getInfoAsync(MEDIA_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(MEDIA_DIR, { intermediates: true });
}

async function saveLibrary(items) {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

async function saveAlbums(albums) {
  await AsyncStorage.setItem(ALBUMS_KEY, JSON.stringify(albums));
}

async function removePhysicalFile(item) {
  try {
    const info = await FileSystem.getInfoAsync(item.uri);
    if (info.exists) await FileSystem.deleteAsync(item.uri, { idempotent: true });
  } catch {}
}

function normalizeItem(item) {
  return {
    ...item,
    favorite: !!item.favorite,
    reviewed: !!item.reviewed,
    albumIds: Array.isArray(item.albumIds) ? item.albumIds : [],
  };
}

async function loadLibrary() {
  await ensureMediaDir();
  let raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) raw = await AsyncStorage.getItem(LEGACY_STORAGE_KEY);
  const items = (raw ? JSON.parse(raw) : []).map(normalizeItem);
  const cutoff = Date.now() - THIRTY_DAYS;
  const keep = [];
  let changed = false;

  for (const item of items) {
    if (item.deletedAt && item.deletedAt < cutoff) {
      changed = true;
      await removePhysicalFile(item);
    } else {
      keep.push(item);
    }
  }

  const current = await AsyncStorage.getItem(STORAGE_KEY);
  if (changed || !current) await saveLibrary(keep);
  return keep;
}

async function loadAlbums() {
  const raw = await AsyncStorage.getItem(ALBUMS_KEY);
  return raw ? JSON.parse(raw) : [];
}

function extensionFor(asset) {
  const value = String(asset.fileName || asset.name || asset.mimeType || '').toLowerCase();
  const match = value.match(/\.([a-z0-9]+)$/);
  if (match) return match[1];
  if (value.includes('png')) return 'png';
  if (value.includes('heic')) return 'heic';
  if (value.includes('webp')) return 'webp';
  if (value.includes('gif')) return 'gif';
  return 'jpg';
}

async function importAssets(assets, source) {
  await ensureMediaDir();
  const now = Date.now();
  const result = [];

  for (let i = 0; i < assets.length; i += 1) {
    const asset = assets[i];
    const from = asset.uri;
    if (!from) continue;
    const id = `${now}-${i}-${Math.random().toString(36).slice(2, 9)}`;
    const destination = MEDIA_DIR + id + '.' + extensionFor(asset);
    await FileSystem.copyAsync({ from, to: destination });

    result.push({
      id,
      uri: destination,
      name: asset.fileName || asset.name || `Photo ${i + 1}`,
      mimeType: asset.mimeType || 'image/jpeg',
      size: asset.fileSize || asset.size || null,
      width: asset.width || null,
      height: asset.height || null,
      importedAt: now + i,
      favorite: false,
      reviewed: false,
      reviewedAt: null,
      deletedAt: null,
      source,
      albumIds: [],
    });
  }

  return result;
}

function formatBytes(bytes) {
  if (!bytes || Number.isNaN(Number(bytes))) return 'Unknown size';
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function App() {
  const [items, setItems] = useState([]);
  const [albums, setAlbums] = useState([]);
  const [tab, setTab] = useState('photos');
  const [loading, setLoading] = useState(true);
  const [viewer, setViewer] = useState(null);
  const [query, setQuery] = useState('');
  const [cleanupQueue, setCleanupQueue] = useState([]);
  const [cleanupIndex, setCleanupIndex] = useState(0);
  const [pendingDelete, setPendingDelete] = useState([]);
  const [lastAction, setLastAction] = useState(null);
  const [album, setAlbum] = useState(null);
  const [showCreateAlbum, setShowCreateAlbum] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState('');

  useEffect(() => {
    (async () => {
      const [library, storedAlbums] = await Promise.all([loadLibrary(), loadAlbums()]);
      setItems(library);
      setAlbums(storedAlbums);
      setLoading(false);
    })();
  }, []);

  const active = useMemo(() => items.filter((item) => !item.deletedAt), [items]);
  const deleted = useMemo(() => items.filter((item) => !!item.deletedAt), [items]);
  const favorites = useMemo(() => active.filter((item) => item.favorite), [active]);
  const unreviewed = useMemo(() => active.filter((item) => !item.reviewed), [active]);
  const totalBytes = useMemo(() => active.reduce((sum, item) => sum + Number(item.size || 0), 0), [active]);
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return active;
    return active.filter((item) =>
      item.name.toLowerCase().includes(q) ||
      albums.some((a) => item.albumIds.includes(a.id) && a.name.toLowerCase().includes(q))
    );
  }, [active, query, albums]);

  async function commit(next) {
    setItems(next);
    await saveLibrary(next);
  }

  async function commitAlbums(next) {
    setAlbums(next);
    await saveAlbums(next);
  }

  async function addImported(imported) {
    if (!imported.length) return;
    await commit(imported.concat(items));
    setTab('photos');
  }

  async function pickFromPhotos() {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Photos permission needed', 'Frame needs permission to copy the photos you choose into its own private library.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: 0,
        quality: 1,
        orderedSelection: true,
      });
      if (result.canceled || !result.assets?.length) return;

      setLoading(true);
      await addImported(await importAssets(result.assets, 'photos'));
    } catch (error) {
      Alert.alert('Import failed', error?.message || 'Frame could not import those photos.');
    } finally {
      setLoading(false);
    }
  }

  async function pickFromFiles() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'image/*',
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;

      setLoading(true);
      await addImported(await importAssets(result.assets, 'files'));
    } catch (error) {
      Alert.alert('Import failed', error?.message || 'Frame could not import those files.');
    } finally {
      setLoading(false);
    }
  }

  function showImportMenu() {
    Alert.alert('Import photos', 'Choose where Frame should copy photos from.', [
      { text: 'Apple Photos', onPress: pickFromPhotos },
      { text: 'Files / Takeout', onPress: pickFromFiles },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  function openCleanup(reviewAll = false) {
    setCleanupQueue(active.filter((item) => reviewAll || !item.reviewed));
    setCleanupIndex(0);
    setPendingDelete([]);
    setLastAction(null);
    setTab('cleanup');
  }

  async function keep(item) {
    const previous = items.find((x) => x.id === item.id);
    const next = items.map((x) => x.id === item.id ? { ...x, reviewed: true, reviewedAt: Date.now() } : x);
    await commit(next);
    setLastAction({ type: 'keep', item: previous });
    setCleanupIndex((value) => value + 1);
  }

  function markDelete(item) {
    setPendingDelete((ids) => ids.includes(item.id) ? ids : ids.concat(item.id));
    setLastAction({ type: 'delete', item });
    setCleanupIndex((value) => value + 1);
  }

  async function undo() {
    if (!lastAction) return;

    if (lastAction.type === 'delete') {
      setPendingDelete((ids) => ids.filter((id) => id !== lastAction.item.id));
    } else {
      await commit(items.map((x) => x.id === lastAction.item.id ? lastAction.item : x));
    }

    setCleanupIndex((value) => Math.max(0, value - 1));
    setLastAction(null);
  }

  async function finishCleanup() {
    const doomed = new Set(pendingDelete);
    const now = Date.now();
    const next = items.map((item) => doomed.has(item.id)
      ? { ...item, deletedAt: now, reviewed: true, reviewedAt: now }
      : item);
    await commit(next);
    setPendingDelete([]);
    setLastAction(null);
    setTab('photos');
  }

  async function resetReviewed() {
    const next = items.map((item) => item.deletedAt ? item : { ...item, reviewed: false, reviewedAt: null });
    await commit(next);
    setCleanupQueue(next.filter((item) => !item.deletedAt));
    setCleanupIndex(0);
    setPendingDelete([]);
    setLastAction(null);
    setTab('cleanup');
  }

  async function toggleFavorite(id) {
    const next = items.map((item) => item.id === id ? { ...item, favorite: !item.favorite } : item);
    await commit(next);
    setViewer((current) => current?.id === id ? next.find((item) => item.id === id) : current);
  }

  async function moveToDeleted(id) {
    await commit(items.map((item) => item.id === id ? { ...item, deletedAt: Date.now() } : item));
    setViewer(null);
  }

  async function restore(id) {
    await commit(items.map((item) => item.id === id ? { ...item, deletedAt: null } : item));
  }

  async function erase(item) {
    await removePhysicalFile(item);
    await commit(items.filter((x) => x.id !== item.id));
  }

  async function eraseAllDeleted() {
    for (const item of deleted) await removePhysicalFile(item);
    await commit(items.filter((item) => !item.deletedAt));
  }

  async function createAlbum() {
    const name = newAlbumName.trim();
    if (!name) return;
    const next = albums.concat({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      createdAt: Date.now(),
    });
    await commitAlbums(next);
    setNewAlbumName('');
    setShowCreateAlbum(false);
  }

  async function deleteAlbum(id) {
    const nextAlbums = albums.filter((a) => a.id !== id);
    const nextItems = items.map((item) => ({ ...item, albumIds: item.albumIds.filter((albumId) => albumId !== id) }));
    await Promise.all([commitAlbums(nextAlbums), commit(nextItems)]);
    setAlbum(null);
  }

  async function toggleItemInAlbum(itemId, albumId) {
    const next = items.map((item) => {
      if (item.id !== itemId) return item;
      const has = item.albumIds.includes(albumId);
      return {
        ...item,
        albumIds: has ? item.albumIds.filter((id) => id !== albumId) : item.albumIds.concat(albumId),
      };
    });
    await commit(next);
    setViewer((current) => current?.id === itemId ? next.find((item) => item.id === itemId) : current);
  }

  function albumItems(id) {
    return active.filter((item) => item.albumIds.includes(id));
  }

  function selectedAlbumItems() {
    if (!album) return [];
    if (album === 'all') return active;
    if (album === 'favorites') return favorites;
    if (album === 'deleted') return deleted;
    return albumItems(album);
  }

  function selectedAlbumTitle() {
    if (album === 'all') return 'All Photos';
    if (album === 'favorites') return 'Favourites';
    if (album === 'deleted') return 'Recently Deleted';
    return albums.find((a) => a.id === album)?.name || 'Album';
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.loading}>
        <StatusBar style="light" />
        <ActivityIndicator size="large" color="#fff" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />

      <View style={styles.body}>
        {tab === 'photos' && (
          <>
            <Header title="Frame" action="Import" onAction={showImportMenu} />
            {active.length ? (
              <>
                <LibraryStats
                  count={active.length}
                  unreviewed={unreviewed.length}
                  favorites={favorites.length}
                  size={formatBytes(totalBytes)}
                  onCleanup={() => openCleanup(false)}
                />
                <PhotoGrid items={active} onOpen={setViewer} />
              </>
            ) : (
              <EmptyLibrary onImport={showImportMenu} />
            )}
          </>
        )}

        {tab === 'albums' && (
          album ? (
            <AlbumView
              title={selectedAlbumTitle()}
              type={album}
              items={selectedAlbumItems()}
              custom={albums.some((a) => a.id === album)}
              onBack={() => setAlbum(null)}
              onOpen={setViewer}
              onRestore={restore}
              onErase={erase}
              onEraseAll={eraseAllDeleted}
              onDeleteAlbum={deleteAlbum}
            />
          ) : (
            <>
              <Header title="Albums" action="New" onAction={() => setShowCreateAlbum(true)} />
              <ScrollView contentContainerStyle={styles.albumList}>
                <AlbumRow icon="▦" title="All Photos" count={active.length} onPress={() => setAlbum('all')} />
                <AlbumRow icon="♥" title="Favourites" count={favorites.length} onPress={() => setAlbum('favorites')} />
                <AlbumRow icon="⌫" title="Recently Deleted" count={deleted.length} onPress={() => setAlbum('deleted')} />
                {albums.map((a) => (
                  <AlbumRow key={a.id} icon="▣" title={a.name} count={albumItems(a.id).length} onPress={() => setAlbum(a.id)} />
                ))}
                <View style={styles.note}>
                  <Text style={styles.noteTitle}>Standalone by design</Text>
                  <Text style={styles.noteText}>Frame copies selected photos into its own private library. Swiping or deleting here does not delete the originals from Apple Photos.</Text>
                </View>
              </ScrollView>
            </>
          )
        )}

        {tab === 'cleanup' && (
          <Cleanup
            queue={cleanupQueue}
            index={cleanupIndex}
            pending={pendingDelete.length}
            canUndo={!!lastAction}
            onKeep={keep}
            onDelete={markDelete}
            onUndo={undo}
            onFinish={finishCleanup}
            onReviewAll={() => openCleanup(true)}
            onReset={resetReviewed}
          />
        )}

        {tab === 'search' && (
          <>
            <Header title="Search" />
            <View style={styles.searchWrap}>
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search filenames or albums"
                placeholderTextColor="#777"
                style={styles.search}
                autoCapitalize="none"
              />
            </View>
            {searchResults.length ? <PhotoGrid items={searchResults} onOpen={setViewer} /> : <EmptyText text="No matching photos." />}
          </>
        )}
      </View>

      <TabBar
        active={tab}
        onChange={(next) => {
          if (next === 'cleanup') openCleanup(false);
          else {
            setAlbum(null);
            setTab(next);
          }
        }}
      />

      <Viewer
        item={viewer}
        albums={albums}
        onClose={() => setViewer(null)}
        onFavorite={toggleFavorite}
        onDelete={moveToDeleted}
        onToggleAlbum={toggleItemInAlbum}
      />

      <CreateAlbumModal
        visible={showCreateAlbum}
        value={newAlbumName}
        onChange={setNewAlbumName}
        onCancel={() => {
          setShowCreateAlbum(false);
          setNewAlbumName('');
        }}
        onCreate={createAlbum}
      />
    </SafeAreaView>
  );
}

function Header({ title, action, onAction }) {
  return (
    <View style={styles.header}>
      <Text style={styles.title}>{title}</Text>
      {action ? <Pressable onPress={onAction}><Text style={styles.headerAction}>{action}</Text></Pressable> : null}
    </View>
  );
}

function LibraryStats({ count, unreviewed, favorites, size, onCleanup }) {
  return (
    <View style={styles.statsWrap}>
      <View style={styles.statsCard}>
        <View><Text style={styles.statValue}>{count}</Text><Text style={styles.statLabel}>Photos</Text></View>
        <View><Text style={styles.statValue}>{unreviewed}</Text><Text style={styles.statLabel}>To review</Text></View>
        <View><Text style={styles.statValue}>{favorites}</Text><Text style={styles.statLabel}>Favourites</Text></View>
        <View><Text style={styles.statValue}>{size}</Text><Text style={styles.statLabel}>Stored</Text></View>
      </View>
      {unreviewed > 0 ? (
        <Pressable onPress={onCleanup} style={styles.cleanupBanner}>
          <Text style={styles.cleanupBannerTitle}>Continue cleanup</Text>
          <Text style={styles.cleanupBannerText}>{unreviewed} photos waiting · swipe left to keep, right to delete →</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function EmptyLibrary({ onImport }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyGlyph}>▣</Text>
      <Text style={styles.emptyTitle}>Your photo library, minus the clutter.</Text>
      <Text style={styles.emptyCopy}>Import from Apple Photos or Files. Frame keeps its own copy, so cleanup here leaves your original library untouched.</Text>
      <Pressable onPress={onImport} style={styles.primary}><Text style={styles.primaryText}>Import photos</Text></Pressable>
    </View>
  );
}

function PhotoGrid({ items, onOpen }) {
  const gap = 2;
  const cell = (SCREEN - gap * 2) / 3;
  return (
    <FlatList
      data={items}
      numColumns={3}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ paddingBottom: 110 }}
      columnWrapperStyle={{ gap, marginBottom: gap }}
      initialNumToRender={18}
      windowSize={7}
      renderItem={({ item }) => (
        <Pressable onPress={() => onOpen(item)} style={{ width: cell, height: cell, backgroundColor: COLORS.card }}>
          <Image source={{ uri: item.uri }} style={StyleSheet.absoluteFill} contentFit="cover" recyclingKey={item.id} />
          {item.favorite ? <View style={styles.favoriteDot} /> : null}
        </Pressable>
      )}
    />
  );
}

function AlbumRow({ icon, title, count, onPress }) {
  return (
    <Pressable onPress={onPress} style={styles.albumRow}>
      <View style={styles.albumIcon}><Text style={styles.albumGlyph}>{icon}</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.albumTitle}>{title}</Text>
        <Text style={styles.albumCount}>{count} {count === 1 ? 'photo' : 'photos'}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

function AlbumView({ title, type, items, custom, onBack, onOpen, onRestore, onErase, onEraseAll, onDeleteAlbum }) {
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.subHeader}>
        <Pressable onPress={onBack}><Text style={styles.back}>‹ Albums</Text></Pressable>
        <Text style={styles.subTitle} numberOfLines={1}>{title}</Text>
        {custom ? (
          <Pressable onPress={() => Alert.alert('Delete album?', 'Photos stay in Frame. Only this album is removed.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: () => onDeleteAlbum(type) },
          ])}><Text style={styles.albumDelete}>Delete</Text></Pressable>
        ) : <View style={{ width: 70 }} />}
      </View>

      {!items.length ? <EmptyText text="Nothing here yet." /> : type !== 'deleted' ? (
        <PhotoGrid items={items} onOpen={onOpen} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 110 }}>
          <View style={styles.deletedHeader}>
            <Text style={styles.deletedHint}>Automatically removed after 30 days.</Text>
            <Pressable onPress={() => Alert.alert('Delete all permanently?', 'This cannot be undone.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete All', style: 'destructive', onPress: onEraseAll },
            ])}><Text style={styles.erase}>Delete All</Text></Pressable>
          </View>
          {items.map((item) => (
            <View key={item.id} style={styles.deletedRow}>
              <Image source={{ uri: item.uri }} style={styles.deletedThumb} contentFit="cover" />
              <View style={{ flex: 1 }}>
                <Text style={styles.deletedName} numberOfLines={1}>{item.name}</Text>
                <Text style={styles.deletedMeta}>Deleted {new Date(item.deletedAt).toLocaleDateString()}</Text>
              </View>
              <Pressable onPress={() => onRestore(item.id)}><Text style={styles.restore}>Restore</Text></Pressable>
              <Pressable onPress={() => Alert.alert('Delete permanently?', 'This cannot be undone.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: () => onErase(item) },
              ])}><Text style={styles.erase}>Delete</Text></Pressable>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function Cleanup({ queue, index, pending, canUndo, onKeep, onDelete, onUndo, onFinish, onReviewAll, onReset }) {
  const item = queue[index];
  const done = !item;

  return (
    <View style={{ flex: 1 }}>
      <Header title="Cleanup" />
      <View style={styles.cleanupTop}>
        <Text style={styles.progress}>{Math.min(index, queue.length)} / {queue.length} reviewed</Text>
        <Text style={styles.pending}>{pending} to delete</Text>
      </View>

      <View style={styles.cleanupStage}>
        {done ? (
          <View style={styles.summary}>
            <Text style={styles.summaryIcon}>✓</Text>
            <Text style={styles.summaryTitle}>{queue.length ? 'Review complete' : 'Nothing left to review'}</Text>
            <Text style={styles.summaryCopy}>
              {pending
                ? `${pending} ${pending === 1 ? 'photo is' : 'photos are'} ready for Recently Deleted.`
                : 'Everything in this cleanup queue is sorted.'}
            </Text>
            {pending ? <Pressable onPress={onFinish} style={styles.danger}><Text style={styles.primaryText}>Move to Recently Deleted</Text></Pressable> : null}
            <Pressable onPress={onReviewAll} style={styles.secondary}><Text style={styles.secondaryText}>Review all photos</Text></Pressable>
            <Pressable onPress={onReset} style={styles.textButton}><Text style={styles.mutedButton}>Mark all unreviewed</Text></Pressable>
          </View>
        ) : <SwipeCard item={item} onKeep={onKeep} onDelete={onDelete} />}
      </View>

      {!done ? (
        <View style={styles.cleanupActions}>
          <Pressable onPress={() => onKeep(item)} style={[styles.circle, { borderColor: COLORS.green }]}><Text style={styles.circleText}>←</Text></Pressable>
          <Pressable disabled={!canUndo} onPress={onUndo} style={{ opacity: canUndo ? 1 : 0.3, padding: 12 }}><Text style={styles.undo}>Undo</Text></Pressable>
          <Pressable onPress={() => onDelete(item)} style={[styles.circle, { borderColor: COLORS.red }]}><Text style={styles.circleText}>→</Text></Pressable>
        </View>
      ) : null}
    </View>
  );
}

function SwipeCard({ item, onKeep, onDelete }) {
  const pos = useRef(new Animated.ValueXY()).current;

  useEffect(() => {
    pos.setValue({ x: 0, y: 0 });
  }, [item.id, pos]);

  function finish(x, action) {
    Animated.timing(pos, { toValue: { x, y: 0 }, duration: 170, useNativeDriver: false }).start(() => {
      pos.setValue({ x: 0, y: 0 });
      action(item);
    });
  }

  const responder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 6,
    onPanResponderMove: Animated.event([null, { dx: pos.x, dy: pos.y }], { useNativeDriver: false }),
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dx <= -110) finish(-SCREEN * 1.25, onKeep);
      else if (gesture.dx >= 110) finish(SCREEN * 1.25, onDelete);
      else Animated.spring(pos, { toValue: { x: 0, y: 0 }, useNativeDriver: false, friction: 6 }).start();
    },
  }), [item.id, onKeep, onDelete, pos]);

  const rotate = pos.x.interpolate({
    inputRange: [-SCREEN, 0, SCREEN],
    outputRange: ['-10deg', '0deg', '10deg'],
  });
  const keepOpacity = pos.x.interpolate({ inputRange: [-130, -40, 0], outputRange: [1, 0.2, 0], extrapolate: 'clamp' });
  const deleteOpacity = pos.x.interpolate({ inputRange: [0, 40, 130], outputRange: [0, 0.2, 1], extrapolate: 'clamp' });

  return (
    <Animated.View
      {...responder.panHandlers}
      style={[styles.swipeCard, { transform: [{ translateX: pos.x }, { translateY: pos.y }, { rotate }] }]}
    >
      <Image source={{ uri: item.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
      <Animated.View style={[styles.swipeBadge, styles.keepBadge, { opacity: keepOpacity }]}>
        <Text style={styles.keepBadgeText}>KEEP</Text>
      </Animated.View>
      <Animated.View style={[styles.swipeBadge, styles.deleteBadge, { opacity: deleteOpacity }]}>
        <Text style={styles.deleteBadgeText}>DELETE</Text>
      </Animated.View>
      <View style={styles.swipeFooter}>
        <Text style={styles.swipeName} numberOfLines={1}>{item.name}</Text>
        <Text style={styles.swipeHint}>← keep   •   delete →</Text>
      </View>
    </Animated.View>
  );
}

function Viewer({ item, albums, onClose, onFavorite, onDelete, onToggleAlbum }) {
  const [showAlbums, setShowAlbums] = useState(false);

  useEffect(() => {
    if (!item) setShowAlbums(false);
  }, [item]);

  return (
    <Modal visible={!!item} animationType="fade" onRequestClose={onClose}>
      <SafeAreaView style={styles.viewer}>
        <StatusBar style="light" />
        {item ? (
          <>
            <View style={styles.viewerTop}>
              <Pressable onPress={onClose}><Text style={styles.viewerButton}>Close</Text></Pressable>
              <Text style={styles.viewerName} numberOfLines={1}>{item.name}</Text>
              <Pressable onPress={() => onFavorite(item.id)}>
                <Text style={[styles.viewerButton, item.favorite && { color: COLORS.yellow }]}>{item.favorite ? '♥' : '♡'}</Text>
              </Pressable>
            </View>
            <View style={{ flex: 1 }}>
              <Image source={{ uri: item.uri }} style={StyleSheet.absoluteFill} contentFit="contain" />
            </View>
            {showAlbums ? (
              <View style={styles.albumPicker}>
                <Text style={styles.albumPickerTitle}>Add to albums</Text>
                {albums.length ? albums.map((album) => {
                  const selected = item.albumIds.includes(album.id);
                  return (
                    <Pressable key={album.id} onPress={() => onToggleAlbum(item.id, album.id)} style={styles.albumPickerRow}>
                      <Text style={styles.albumPickerName}>{album.name}</Text>
                      <Text style={[styles.albumPickerCheck, selected && { color: COLORS.green }]}>{selected ? '✓' : '+'}</Text>
                    </Pressable>
                  );
                }) : <Text style={styles.albumPickerEmpty}>Create an album from the Albums tab first.</Text>}
              </View>
            ) : null}
            <View style={styles.viewerBottom}>
              <Pressable onPress={() => onFavorite(item.id)} style={styles.viewerAction}>
                <Text style={styles.viewerIcon}>{item.favorite ? '♥' : '♡'}</Text>
                <Text style={styles.viewerActionText}>Favourite</Text>
              </Pressable>
              <Pressable onPress={() => setShowAlbums((value) => !value)} style={styles.viewerAction}>
                <Text style={styles.viewerIcon}>▣</Text>
                <Text style={styles.viewerActionText}>Albums</Text>
              </Pressable>
              <Pressable
                onPress={() => Alert.alert('Move to Recently Deleted?', 'You can restore it for 30 days.', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Delete', style: 'destructive', onPress: () => onDelete(item.id) },
                ])}
                style={styles.viewerAction}
              >
                <Text style={[styles.viewerIcon, { color: COLORS.red }]}>⌫</Text>
                <Text style={[styles.viewerActionText, { color: COLORS.red }]}>Delete</Text>
              </Pressable>
            </View>
          </>
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

function CreateAlbumModal({ visible, value, onChange, onCancel, onCreate }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalShade}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>New album</Text>
          <TextInput
            value={value}
            onChangeText={onChange}
            placeholder="Album name"
            placeholderTextColor="#777"
            style={styles.modalInput}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={onCreate}
          />
          <View style={styles.modalButtons}>
            <Pressable onPress={onCancel} style={styles.modalButton}><Text style={styles.modalCancel}>Cancel</Text></Pressable>
            <Pressable onPress={onCreate} style={styles.modalButton}><Text style={styles.modalCreate}>Create</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function EmptyText({ text }) {
  return <View style={styles.empty}><Text style={styles.emptyCopy}>{text}</Text></View>;
}

function TabBar({ active, onChange }) {
  const tabs = [
    ['photos', '▦', 'Photos'],
    ['albums', '▣', 'Albums'],
    ['cleanup', '↔', 'Cleanup'],
    ['search', '⌕', 'Search'],
  ];

  return (
    <View style={styles.tabs}>
      {tabs.map(([key, icon, label]) => {
        const selected = active === key;
        return (
          <Pressable key={key} style={styles.tab} onPress={() => onChange(key)}>
            <Text style={[styles.tabIcon, selected && styles.tabSelected]}>{icon}</Text>
            <Text style={[styles.tabLabel, selected && styles.tabSelected]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  body: { flex: 1, backgroundColor: COLORS.bg },
  loading: { flex: 1, backgroundColor: COLORS.bg, alignItems: 'center', justifyContent: 'center' },
  header: { height: 64, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: COLORS.text, fontSize: 34, lineHeight: 40, fontWeight: '800', letterSpacing: -1.2 },
  headerAction: { color: COLORS.accent, fontSize: 16, fontWeight: '700', padding: 8 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 34, paddingBottom: 110 },
  emptyGlyph: { color: COLORS.text, fontSize: 54, marginBottom: 18 },
  emptyTitle: { color: COLORS.text, fontSize: 26, fontWeight: '800', textAlign: 'center' },
  emptyCopy: { color: COLORS.muted, fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 10, maxWidth: 360 },
  primary: { backgroundColor: '#fff', paddingHorizontal: 22, paddingVertical: 14, borderRadius: 999, marginTop: 24 },
  primaryText: { color: '#000', fontSize: 15, fontWeight: '800' },
  secondary: { borderWidth: 1, borderColor: COLORS.line, paddingHorizontal: 18, paddingVertical: 13, borderRadius: 999, marginTop: 12 },
  secondaryText: { color: COLORS.text, fontWeight: '800' },
  textButton: { padding: 13, marginTop: 2 },
  mutedButton: { color: COLORS.muted, fontWeight: '700' },
  favoriteDot: { position: 'absolute', right: 7, top: 7, width: 9, height: 9, borderRadius: 5, backgroundColor: COLORS.yellow, borderWidth: 1, borderColor: '#000' },
  statsWrap: { paddingHorizontal: 12, paddingBottom: 12, gap: 9 },
  statsCard: { backgroundColor: COLORS.card, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 12, flexDirection: 'row', justifyContent: 'space-between' },
  statValue: { color: COLORS.text, fontWeight: '800', fontSize: 14 },
  statLabel: { color: COLORS.muted, fontSize: 10, marginTop: 2 },
  cleanupBanner: { backgroundColor: COLORS.card2, borderRadius: 16, padding: 13 },
  cleanupBannerTitle: { color: COLORS.text, fontWeight: '800', fontSize: 14 },
  cleanupBannerText: { color: COLORS.muted, fontSize: 11, marginTop: 3 },
  albumList: { padding: 16, gap: 10, paddingBottom: 120 },
  albumRow: { backgroundColor: COLORS.card, borderRadius: 18, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 13 },
  albumIcon: { width: 54, height: 54, borderRadius: 14, backgroundColor: COLORS.card2, alignItems: 'center', justifyContent: 'center' },
  albumGlyph: { color: COLORS.text, fontSize: 25 },
  albumTitle: { color: COLORS.text, fontWeight: '700', fontSize: 16 },
  albumCount: { color: COLORS.muted, marginTop: 3, fontSize: 13 },
  chevron: { color: COLORS.muted, fontSize: 30, paddingRight: 5 },
  note: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 18, padding: 17, marginTop: 12 },
  noteTitle: { color: COLORS.text, fontWeight: '800', fontSize: 15 },
  noteText: { color: COLORS.muted, lineHeight: 20, fontSize: 13, marginTop: 6 },
  subHeader: { height: 58, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  back: { color: COLORS.accent, width: 70, fontWeight: '700' },
  subTitle: { color: COLORS.text, fontWeight: '800', fontSize: 18, maxWidth: '55%' },
  albumDelete: { color: COLORS.red, width: 70, textAlign: 'right', fontWeight: '700' },
  deletedHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  deletedHint: { color: COLORS.muted, flex: 1 },
  deletedRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: COLORS.card, padding: 9, borderRadius: 14 },
  deletedThumb: { width: 52, height: 52, borderRadius: 10 },
  deletedName: { color: COLORS.text, fontWeight: '700', fontSize: 13 },
  deletedMeta: { color: COLORS.muted, fontSize: 11, marginTop: 2 },
  restore: { color: COLORS.accent, fontWeight: '800', fontSize: 12 },
  erase: { color: COLORS.red, fontWeight: '800', fontSize: 12 },
  cleanupTop: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 18, paddingBottom: 12 },
  progress: { color: COLORS.muted, fontSize: 13, fontWeight: '700' },
  pending: { color: COLORS.red, fontSize: 13, fontWeight: '800' },
  cleanupStage: { flex: 1, justifyContent: 'center' },
  cleanupActions: { height: 100, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 28 },
  circle: { width: 62, height: 62, borderRadius: 31, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  circleText: { color: '#fff', fontSize: 28, fontWeight: '900' },
  undo: { color: COLORS.muted, fontWeight: '700' },
  swipeCard: { width: SCREEN - 34, height: SCREEN * 1.12, borderRadius: 28, overflow: 'hidden', backgroundColor: COLORS.card, alignSelf: 'center' },
  swipeBadge: { position: 'absolute', top: 28, paddingHorizontal: 13, paddingVertical: 7, borderRadius: 10, borderWidth: 3 },
  keepBadge: { left: 24, borderColor: COLORS.green, transform: [{ rotate: '-8deg' }] },
  deleteBadge: { right: 24, borderColor: COLORS.red, transform: [{ rotate: '8deg' }] },
  keepBadgeText: { color: COLORS.green, fontSize: 24, fontWeight: '900' },
  deleteBadgeText: { color: COLORS.red, fontSize: 24, fontWeight: '900' },
  swipeFooter: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 18, backgroundColor: 'rgba(0,0,0,0.48)' },
  swipeName: { color: '#fff', fontSize: 15, fontWeight: '700' },
  swipeHint: { color: 'rgba(255,255,255,0.75)', marginTop: 3, fontSize: 12 },
  summary: { margin: 24, backgroundColor: COLORS.card, borderRadius: 26, padding: 28, alignItems: 'center' },
  summaryIcon: { color: COLORS.green, fontSize: 44, fontWeight: '900' },
  summaryTitle: { color: COLORS.text, fontSize: 24, fontWeight: '800', marginTop: 7, textAlign: 'center' },
  summaryCopy: { color: COLORS.muted, textAlign: 'center', lineHeight: 21, marginTop: 8 },
  danger: { backgroundColor: COLORS.red, paddingHorizontal: 18, paddingVertical: 14, borderRadius: 999, marginTop: 22 },
  searchWrap: { paddingHorizontal: 15, paddingBottom: 12 },
  search: { height: 46, borderRadius: 14, backgroundColor: COLORS.card, color: COLORS.text, paddingHorizontal: 15, fontSize: 16 },
  tabs: { height: 76, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.line, backgroundColor: '#111113', flexDirection: 'row', paddingTop: 9, paddingBottom: 10 },
  tab: { flex: 1, alignItems: 'center', gap: 3 },
  tabIcon: { color: COLORS.muted, fontSize: 23, fontWeight: '700' },
  tabLabel: { color: COLORS.muted, fontSize: 11, fontWeight: '600' },
  tabSelected: { color: COLORS.text },
  viewer: { flex: 1, backgroundColor: '#000' },
  viewerTop: { height: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  viewerButton: { color: '#fff', fontSize: 16, fontWeight: '700', minWidth: 50 },
  viewerName: { color: COLORS.muted, fontWeight: '600', maxWidth: '55%', fontSize: 13 },
  viewerBottom: { height: 86, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#333', flexDirection: 'row', justifyContent: 'space-evenly', alignItems: 'center' },
  viewerAction: { alignItems: 'center', minWidth: 90 },
  viewerIcon: { color: '#fff', fontSize: 27 },
  viewerActionText: { color: '#fff', fontSize: 11, marginTop: 3, fontWeight: '600' },
  albumPicker: { maxHeight: 220, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#333', backgroundColor: '#111', padding: 14 },
  albumPickerTitle: { color: COLORS.text, fontWeight: '800', marginBottom: 7 },
  albumPickerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 9 },
  albumPickerName: { color: COLORS.text, fontSize: 14 },
  albumPickerCheck: { color: COLORS.muted, fontSize: 20, fontWeight: '900' },
  albumPickerEmpty: { color: COLORS.muted, fontSize: 13, paddingVertical: 10 },
  modalShade: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'center', padding: 28 },
  modalCard: { backgroundColor: COLORS.card, borderRadius: 24, padding: 20 },
  modalTitle: { color: COLORS.text, fontSize: 22, fontWeight: '800' },
  modalInput: { height: 48, borderRadius: 14, backgroundColor: COLORS.card2, color: COLORS.text, paddingHorizontal: 14, fontSize: 16, marginTop: 16 },
  modalButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 12 },
  modalButton: { paddingHorizontal: 12, paddingVertical: 9 },
  modalCancel: { color: COLORS.muted, fontWeight: '700' },
  modalCreate: { color: COLORS.accent, fontWeight: '800' },
});
