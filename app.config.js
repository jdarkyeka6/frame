function googleRedirectScheme(clientId) {
  const suffix = '.apps.googleusercontent.com';
  const value = String(clientId || '').trim();
  if (!value.endsWith(suffix)) return null;
  const clientKey = value.slice(0, -suffix.length);
  return clientKey ? `com.googleusercontent.apps.${clientKey}` : null;
}

module.exports = ({ config }) => {
  const googleScheme = googleRedirectScheme(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID);
  const currentSchemes = Array.isArray(config.scheme)
    ? config.scheme
    : config.scheme
      ? [config.scheme]
      : [];

  return {
    ...config,
    scheme: googleScheme
      ? [...new Set([...currentSchemes, googleScheme])]
      : currentSchemes,
  };
};
