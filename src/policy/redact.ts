const PATTERNS: RegExp[] = [
  /\b(?:sk|api|key|token|secret)[-_][a-zA-Z0-9_-]{12,}\b/gi,
  /\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}/gi,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g,
  /\b(?:set-cookie|cookie)\s*:\s*[^\s]{8,}/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

export function redactText(text: string): string {
  return PATTERNS.reduce((value, pattern) => value.replace(pattern, '[REDACTED]'), text);
}

export function redact<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => {
        if (/^(?:authorization|token|apiKey|api_key|secret|cookie|password|privateKey)$/i.test(key))
          return [key, '[REDACTED]'];
        return [key, redact(item)];
      }),
    ) as T;
  }
  return value;
}
