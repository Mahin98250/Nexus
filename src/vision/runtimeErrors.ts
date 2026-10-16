export type RuntimeErrorDetails = {
  name: string;
  message: string;
};

/**
 * Browser APIs sometimes reject with DOMException or another Error-like object
 * that is not an instanceof Error in a particular webview. Read its shape
 * instead of replacing the useful cause with a generic message.
 */
export function getRuntimeErrorDetails(error: unknown): RuntimeErrorDetails {
  // Resource loading can reject with an Event (for example, script.onerror)
  // rather than an Error. JSON.stringify(Event) often yields only {"isTrusted":true},
  // which hides the URL and the actual failed stage.
  if (typeof Event !== 'undefined' && error instanceof Event) {
    const target = error.target as (EventTarget & { src?: string; href?: string; currentSrc?: string; tagName?: string }) | null;
    const resource = target?.currentSrc || target?.src || target?.href || '';
    const tag = target?.tagName ? ` ${target.tagName.toLowerCase()}` : '';
    return {
      name: error.type ? `ResourceEvent(${error.type})` : 'ResourceEvent',
      message: `A browser resource${tag} failed to load${resource ? ` (${resource})` : ''}.`,
    };
  }
  if (typeof error === 'string') {
    return { name: '', message: error.trim() || 'The operation failed without an error message.' };
  }
  if (typeof error === 'number' || typeof error === 'boolean') {
    return { name: '', message: String(error) };
  }
  if (error && typeof error === 'object') {
    const value = error as { name?: unknown; message?: unknown; toString?: () => string };
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const message = typeof value.message === 'string' ? value.message.trim() : '';
    if (message) return { name, message };
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return { name, message: serialized };
    } catch {
      // Some browser-provided exception objects are not serializable.
    }
    return { name, message: 'The browser did not provide an error message.' };
  }
  return { name: '', message: 'The browser reported an unknown failure.' };
}
