import * as WebBrowser from 'expo-web-browser';
import { googleJson } from './googleApi';

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

export async function pickGooglePhotos(token, onProgress) {
  const session = await createPickerSession(token);
  if (!session?.id || !session?.pickerUri) {
    throw new Error('Google Photos could not start a picker session.');
  }

  try {
    onProgress?.({ phase: 'pick', message: 'Choose up to 2,000 photos for this batch' });
    await WebBrowser.openBrowserAsync(session.pickerUri);

    onProgress?.({ phase: 'waiting', message: 'Reading this Google Photos batch…' });
    await waitForPicker(token, session);
    return await listPickedMedia(token, session.id);
  } finally {
    await fetch(
      `https://photospicker.googleapis.com/v1/sessions/${encodeURIComponent(session.id)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    ).catch(() => {});
  }
}
