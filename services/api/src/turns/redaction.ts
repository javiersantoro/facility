/** Redact string content without treating JSON numbers or booleans as secret text. */
export function redactEvent(value: unknown, secrets: string[]): Record<string, unknown> {
  function visit(input: unknown): unknown {
    if (typeof input === "string") return redactString(input, secrets);
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input).map(([key, item]) => [redactString(key, secrets), visit(item)]),
      );
    return input;
  }
  return visit(value) as Record<string, unknown>;
}

export function redactString(value: string, secrets: string[]) {
  return secrets
    .filter(Boolean)
    .reduce((current, secret) => current.replaceAll(secret, "[REDACTED]"), value);
}

/** Hold back a credential that may be split between streamed reply snapshots. */
export function redactEngineActivity(
  event: { type: string; data: Record<string, unknown> },
  secrets: string[],
) {
  const data = redactEvent(event.data, secrets);
  if (
    event.type !== "reply_text" ||
    typeof data.text !== "string" ||
    (data.complete === true && data.excerpt !== true)
  )
    return data;

  const value = data.text;
  let held = 0;
  for (const secret of secrets) {
    for (let length = Math.min(secret.length - 1, value.length); length > held; length--) {
      if (value.endsWith(secret.slice(0, length))) {
        held = length;
        break;
      }
    }
  }
  return { ...data, text: value.slice(0, value.length - held) };
}
