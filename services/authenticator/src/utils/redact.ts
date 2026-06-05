// E1: redact email addresses for log lines. Login attempts (success or
// failure) should not write a plaintext email/PII into the log stream where
// it ends up in shipped logs / sidecar collectors. Mask the local-part to
// the first 3 chars + the local-part length so debugging can still pivot on
// "is this the same address?" without leaking the address itself.
//
// Examples:
//   user@example.com   -> use***(4)@example.com
//   ab@example.com     -> ab(2)@example.com
//   no-at-sign         -> ***
export function redactEmail(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    return '***';
  }
  const at = value.lastIndexOf('@');
  if (at < 0) {
    return '***';
  }
  const local = value.slice(0, at);
  const domain = value.slice(at);
  if (!local) {
    return `***${domain}`;
  }
  const head = local.slice(0, 3);
  if (local.length <= 3) {
    return `${head}(${local.length})${domain}`;
  }
  return `${head}***(${local.length})${domain}`;
}
