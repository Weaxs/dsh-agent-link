const PATTERNS: RegExp[] = [
  /\b(?:sk|api|key|token|secret)[-_][a-zA-Z0-9_-]{12,}\b/gi,
  /\b(?:gh[pousr]_[a-zA-Z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g,
  /\b(?:Bearer|Basic)\s+[a-zA-Z0-9._~+/=-]{12,}/gi,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g,
  /\b(?:set-cookie|cookie)\s*:\s*[^\s]{8,}/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

const SENSITIVE_KEY =
  /^(?:authorization|x[-_]api[-_]key|cookie|set[-_]cookie|password|passwd|secret|client[-_]secret|api[-_]?key|private[-_]?key|(?:access|refresh|session|auth|id)?[-_]?token)$/i;

export function redactText(text: string): string {
  return PATTERNS.reduce((value, pattern) => value.replace(pattern, '[REDACTED]'), text);
}

export function redact<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]' as T;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen)) as T;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (SENSITIVE_KEY.test(key)) return [key, '[REDACTED]'];
      return [key, redact(item, seen)];
    }),
  ) as T;
}
