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

const STORAGE_KEY = 'frame.library.v1';
const MEDIA_DIR = FileSystem.documentDirectory + 'frame-media/';
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const SCREEN = Dimensions.get('window').width;

async function ensureMediaDir() {
  const info = await FileSystem.getInfoAsync(MEDIA_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(MEDIA_DIR, { intermediates: true });
  }
}

async function saveLibrary(items) {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

async function removePhysicalFile(item) {
  try {
    const info = await FileSystem.getInfoAsync(item.uri);
    if (info.exists) await FileSystem.deleteAsync(item.uri, { idempotent: true });
  } catch {}
}

async function loadLibrary() {
  await ensureMediaDir();
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  const items = raw ? JSON.parse(raw) : [];
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

  if (changed) await saveLibrary(keep);
  return keep;
}

function extensionFor(asset) {
  const value = String(asset.name || asset.mimeType || '').toLowerCase();
  const match = value.match(/\.([a-z0-9]+)$/);
  if (match) return match[1];
  if (value.includes('png')) return 'png';
  if (value.includes('heic')) return 'heic';
  if (value.includes('webp')) return 'webp';
  return 'jpg';
}

async function importFiles(assets) {
  await ensureMediaDir();
  const now = Date.now();
  const result = [];

  for (let i = 0; i < assets.length; i += 1) {
    const asset = assets[i];
    const id = String(now) + '-' + String(i) + '-' + Math.random().toString(36).slice(2, 9);
    const destination = MEDIA_DIR + id + '.' + extensionFor(asset);
    await FileSystem.copyAsync({ from: asset.uri, to: destination });

    result.push({
      id,
      uri: destination,
      name: asset.name || ('Photo ' + String(i + 1)),
      mimeType: asset.mimeType || 'image/jpeg',
      size: asset.size || null,
      importedAt: now + i,
      favorite: false,
      reviewed: false,
      reviewedAt: null,
      deletedAt: null,
      source: 'files',
    });
  }

  return result;
}

export default function App() {
  const [items, setItems] = useState([]);
  const [tab, setTab] = useState('photos');
  const [loading, setLoading] = useState(true);
  const [viewer, setViewer] = useState(null);
  const [query, setQuery] = useState('');
  const [cleanupQueue, setCleanupQueue] = useState([]);
  const [cleanupIndex, setCleanupIndex] = useState(0);
  const [pendingDelete, setPendingDelete] = useState([]);
  const [lastAction, setLastAction] = useState(null);
  const [album, setAlbum] = useState(null);

  useEffect(() => {
    (async () => {
      setItems(await loadLibrary());
      setLoading(false);
    })();
  }, []);

  const active = useMemo(() => items.filter((item) => !item.deletedAt), [items]);
  const deleted = useMemo(() => items.filter((item) => !!item.deletedAt), [items]);
  const favorites = useMemo(() => active.filter((item) => item.favorite), [active]);
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return active;
    return active.filter((item) => item.name.toLowerCase().includes(q));
  }, [active, query]);

  async function commit(next) {
    setItems(next);
    await saveLibrary(next);
  }

  async function pickPhotos() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'image/*',
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets || !result.assets.length) return;
      setLoading(true);
      const imported = await importFiles(result.assets);
      await commit(imported.concat(items));
    } catch (error) {
      Alert.alert('Import failed', error && error.message ? error.message : 'Frame could not import those files.');
    } finally {
      setLoading(false);
    }
  }

  function openCleanup() {
    setCleanupQueue(items.filter((item) => !item.deletedAt && !item.reviewed));
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
    setPendingDelete((ids) => ids.concat(item.id));
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

  async function toggleFavorite(id) {
    const next = items.map((item) => item.id === id ? { ...item, favorite: !item.favorite } : item);
    await commit(next);
    setViewer((current) => current && current.id === id ? next.find((item) => item.id === id) : current);
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

  if (loading) {
    return (
      <SafeAreaView style={styles.loading}>
        <StatusBar style="light" />
        <ActivityIndicator size="large" color="#fff" />
      </SafeAreaView>
    );
  }

  const selectedAlbumItems = album === 'favorites' ? favorites : album === 'deleted' ? deleted : active;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />

      <View style={styles.body}>
        {tab === 'photos' && (
          <>
            <Header title="Frame" action="Import" onAction={pickPhotos} />
            {active.length ? (
              <PhotoGrid items={active} onOpen={setViewer} />
            ) : (
              <EmptyLibrary onImport={pickPhotos} />
            )}
          </>
        )}

        {tab === 'albums' && (
          album ? (
            <AlbumView
              title={album === 'favorites' ? 'Favourites' : album === 'deleted' ? 'Recently Deleted' : 'All Photos'}
              type={album}
              items={selectedAlbumItems}
              onBack={() => setAlbum(null)}
              onOpen={setViewer}
              onRestore={restore}
              onErase={erase}
            />
          ) : (
            <>
              <Header title="Albums" />
              <ScrollView contentContainerStyle={styles.albumList}>
                <AlbumRow icon="▦" title="All Photos" count={active.length} onPress={() => setAlbum('all')} />
                <AlbumRow icon="♥" title="Favourites" count={favorites.length} onPress={() => setAlbum('favorites')} />
                <AlbumRow icon="⌫" title="Recently Deleted" count={deleted.length} onPress={() => setAlbum('deleted')} />
                <View style={styles.note}>
                  <Text style={styles.noteTitle}>Google Photos migration</Text>
                  <Text style={styles.noteText}>Frame is the destination library. Google Takeout import and cloud sync are the next backend layer.</Text>
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
          />
        )}

        {tab === 'search' && (
          <>
            <Header title="Search" />
            <View style={styles.searchWrap}>
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search filenames"
                placeholderTextColor="#777"
                style={styles.search}
                autoCapitalize="none"
              />
            </View>
            {searchResults.length ? <PhotoGrid items={searchResults} onOpen={setViewer} /> : <EmptyText text="No matching photos." />}
          </>
        )}
      </View>

      <TabBar active={tab} onChange={(next) => next === 'cleanup' ? openCleanup() : (setAlbum(null), setTab(next))} />

      <Viewer
        item={viewer}
        onClose={() => setViewer(null)}
        onFavorite={toggleFavorite}
        onDelete={moveToDeleted}
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

function EmptyLibrary({ onImport }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyGlyph}>▣</Text>
      <Text style={styles.emptyTitle}>Your new photo library.</Text>
      <Text style={styles.emptyCopy}>Import photos into Frame without changing your Apple Photos library.</Text>
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
      contentContainerStyle={{ paddingBottom: 100 }}
      columnWrapperStyle={{ gap, marginBottom: gap }}
      renderItem={({ item }) => (
        <Pressable onPress={() => onOpen(item)} style={{ width: cell, height: cell, backgroundColor: COLORS.card }}>
          <Image source={{ uri: item.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
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
        <Text style={styles.albumCount}>{count} photos</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

function AlbumView({ title, type, items, onBack, onOpen, onRestore, onErase }) {
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.subHeader}>
        <Pressable onPress={onBack}><Text style={styles.back}>‹ Albums</Text></Pressable>
        <Text style={styles.subTitle}>{title}</Text>
        <View style={{ width: 70 }} />
      </View>

      {!items.length ? <EmptyText text="Nothing here yet." /> : type !== 'deleted' ? (
        <PhotoGrid items={items} onOpen={onOpen} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
          <Text style={styles.deletedHint}>Frame permanently removes items 30 days after deletion.</Text>
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

function Cleanup({ queue, index, pending, canUndo, onKeep, onDelete, onUndo, onFinish }) {
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
            <Text style={styles.summaryCopy}>{pending ? String(pending) + ' photos are ready for Recently Deleted.' : 'No photos are waiting for review.'}</Text>
            {pending ? <Pressable onPress={onFinish} style={styles.danger}><Text style={styles.primaryText}>Move to Recently Deleted</Text></Pressable> : null}
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
  }, [item.id]);

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
  }), [item.id, onKeep, onDelete]);

  const rotate = pos.x.interpolate({
    inputRange: [-SCREEN, 0, SCREEN],
    outputRange: ['-10deg', '0deg', '10deg'],
  });

  return (
    <Animated.View
      {...responder.panHandlers}
      style={[styles.swipeCard, { transform: [{ translateX: pos.x }, { translateY: pos.y }, { rotate }] }]}
    >
      <Image source={{ uri: item.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
      <View style={styles.swipeFooter}>
        <Text style={styles.swipeName} numberOfLines={1}>{item.name}</Text>
        <Text style={styles.swipeHint}>← keep   •   delete →</Text>
      </View>
    </Animated.View>
  );
}

function Viewer({ item, onClose, onFavorite, onDelete }) {
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
            <View style={styles.viewerBottom}>
              <Pressable onPress={() => onFavorite(item.id)} style={styles.viewerAction}>
                <Text style={styles.viewerIcon}>{item.favorite ? '♥' : '♡'}</Text>
                <Text style={styles.viewerActionText}>Favourite</Text>
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
  emptyCopy: { color: COLORS.muted, fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 10, maxWidth: 340 },
  primary: { backgroundColor: '#fff', paddingHorizontal: 22, paddingVertical: 14, borderRadius: 999, marginTop: 24 },
  primaryText: { color: '#000', fontSize: 15, fontWeight: '800' },
  favoriteDot: { position: 'absolute', right: 7, top: 7, width: 9, height: 9, borderRadius: 5, backgroundColor: COLORS.yellow, borderWidth: 1, borderColor: '#000' },
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
  subTitle: { color: COLORS.text, fontWeight: '800', fontSize: 18 },
  deletedHint: { color: COLORS.muted, textAlign: 'center', marginBottom: 4 },
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
  swipeFooter: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 18, backgroundColor: 'rgba(0,0,0,0.48)' },
  swipeName: { color: '#fff', fontSize: 15, fontWeight: '700' },
  swipeHint: { color: 'rgba(255,255,255,0.75)', marginTop: 3, fontSize: 12 },
  summary: { margin: 24, backgroundColor: COLORS.card, borderRadius: 26, padding: 28, alignItems: 'center' },
  summaryIcon: { color: COLORS.green, fontSize: 44, fontWeight: '900' },
  summaryTitle: { color: COLORS.text, fontSize: 24, fontWeight: '800', marginTop: 7 },
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
});
