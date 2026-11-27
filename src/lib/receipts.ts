type Row = { kind: string; tool?: unknown };

export function isReceipt(message: Row): boolean {
  return message.kind === "digest" || message.kind === "compaction" || message.kind === "call" || (message.tool as { newSession?: true } | undefined)?.newSession === true;
}

export function lastNonReceipt<T extends Row>(messages: readonly T[] | undefined): T | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (!isReceipt(messages[i]!)) return messages[i];
  }
  return undefined;
}
