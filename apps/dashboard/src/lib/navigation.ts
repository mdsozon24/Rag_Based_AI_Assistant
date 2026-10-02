/** Only same-site paths may be a post-login destination (no open redirects via ?next=). */
export function safeNext(value: string | null | undefined, fallback = '/'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  try {
    const url = new URL(value, 'https://dashboard.invalid');
    return url.origin === 'https://dashboard.invalid' ? `${url.pathname}${url.search}${url.hash}` : fallback;
  } catch {
    return fallback;
  }
}
