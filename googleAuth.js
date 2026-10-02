import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';

WebBrowser.maybeCompleteAuthSession();

// v2 intentionally forces a fresh consent after adding Drive read access.
const GOOGLE_TOKEN_KEY = 'frame.google.token.v2';

const GOOGLE_SCOPES = [
  'openid',
  'profile',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
];

const DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

function googleClientId() {
  return String(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || '').trim();
}

function googleRedirectScheme(clientId) {
  const suffix = '.apps.googleusercontent.com';
  const value = String(clientId || '').trim();
  if (!value.endsWith(suffix)) return null;
  const clientKey = value.slice(0, -suffix.length);
  return clientKey ? `com.googleusercontent.apps.${clientKey}` : null;
}

export function isGoogleOAuthConfigured() {
  const clientId = googleClientId();
  return !!clientId && !!googleRedirectScheme(clientId);
}

async function saveToken(token, previousRefreshToken = null) {
  const payload = {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken || previousRefreshToken || null,
    expiresIn: Number(token.expiresIn || 3600),
    issuedAt: Number(token.issuedAt || Math.floor(Date.now() / 1000)),
  };
  await SecureStore.setItemAsync(GOOGLE_TOKEN_KEY, JSON.stringify(payload));
  return payload;
}

async function readStoredToken() {
  try {
    const raw = await SecureStore.getItemAsync(GOOGLE_TOKEN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function tokenIsFresh(token) {
  if (!token?.accessToken) return false;
  const issuedAtMs = Number(token.issuedAt || 0) * 1000;
  const expiresMs = Number(token.expiresIn || 0) * 1000;
  return issuedAtMs + expiresMs - 60_000 > Date.now();
}

async function refreshStoredToken(stored) {
  if (!stored?.refreshToken) return null;
  try {
    const refreshed = await AuthSession.refreshAsync(
      {
        clientId: googleClientId(),
        refreshToken: stored.refreshToken,
        scopes: GOOGLE_SCOPES,
      },
      DISCOVERY,
    );
    return saveToken(refreshed, stored.refreshToken);
  } catch {
    return null;
  }
}

async function interactiveGoogleSignIn() {
  const clientId = googleClientId();
  const redirectScheme = googleRedirectScheme(clientId);
  if (!clientId || !redirectScheme) {
    throw new Error('Google connection is not configured for this build yet.');
  }

  const redirectUri = AuthSession.makeRedirectUri({
    native: `${redirectScheme}:/oauth2redirect`,
  });

  const request = new AuthSession.AuthRequest({
    clientId,
    redirectUri,
    responseType: AuthSession.ResponseType.Code,
    scopes: GOOGLE_SCOPES,
    usePKCE: true,
    extraParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
  });

  const result = await request.promptAsync(DISCOVERY);
  if (result.type !== 'success' || !result.params?.code) {
    if (result.type === 'cancel' || result.type === 'dismiss') return null;
    throw new Error(result?.error?.message || 'Google sign-in did not finish.');
  }

  const token = await AuthSession.exchangeCodeAsync(
    {
      clientId,
      code: result.params.code,
      redirectUri,
      extraParams: request.codeVerifier
        ? { code_verifier: request.codeVerifier }
        : undefined,
    },
    DISCOVERY,
  );

  return saveToken(token);
}

export async function getGoogleAccessToken({ interactive = true } = {}) {
  const stored = await readStoredToken();
  if (tokenIsFresh(stored)) return stored.accessToken;

  const refreshed = await refreshStoredToken(stored);
  if (refreshed?.accessToken) return refreshed.accessToken;

  if (!interactive) return null;
  const signedIn = await interactiveGoogleSignIn();
  return signedIn?.accessToken || null;
}
