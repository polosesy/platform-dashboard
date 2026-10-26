// Secrets that applications print by mistake, masked before a log line leaves the API (pure) — kubelet pod logs and
// Loki lines alike. Over-masking a value is better than shipping a credential to a browser: JWTs, bearer tokens,
// key=value secrets (password, token, api key, storage AccountKey, SAS sig; token / session ids too — a Spring MDC
// "[TOKEN-ID:…]" names the caller's session), PEM blocks, 88-character base64 keys.

const MASK = "[REDACTED]";

const RULES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT (header.payload.signature)
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // key=value / key: value / "key":"value" — the value only
  /((?:password|passwd|pwd|secret|client[_-]?secret|token(?:[_-]?id)?|session[_-]?id|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|AccountKey|SharedAccessKey|SharedAccessSignature|sig)\s*["']?\s*[:=]\s*["']?)([^\s"'&;,})\]]{4,})/gi,
  /\b[A-Za-z0-9+/]{86}==/g, // 64-byte keys in base64 (storage account keys)
];

export function redactLogLine(line: string): { line: string; n: number } {
  let n = 0;
  let out = line;
  for (const re of RULES) {
    out = out.replace(re, (...m: string[]) => {
      n++;
      // key=value rule keeps the key
      return m.length > 4 && typeof m[1] === "string" && typeof m[2] === "string" && re.source.startsWith("((?:password") ? `${m[1]}${MASK}` : MASK;
    });
  }
  return { line: out, n };
}

/** A multi-line log text (kubelet) — the count of replaced values */
export function redactLogText(text: string): { text: string; n: number } {
  let n = 0;
  const lines = text.split("\n").map((l) => { const r = redactLogLine(l); n += r.n; return r.line; });
  return { text: lines.join("\n"), n };
}
