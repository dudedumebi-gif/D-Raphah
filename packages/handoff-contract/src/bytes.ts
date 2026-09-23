const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Truncates a string so its UTF-8 encoding is at most `maxBytes` bytes.
 * Never splits a multi-byte sequence: the cut is walked back to the nearest
 * character boundary. ASCII input is unaffected.
 */
export function truncateToByteLength(input: string, maxBytes: number): string {
  if (maxBytes < 0) throw new RangeError("maxBytes must be non-negative");
  const bytes = encoder.encode(input);
  if (bytes.length <= maxBytes) return input;
  let end = maxBytes;
  // 0b10xxxxxx marks a UTF-8 continuation byte; back up past them.
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return decoder.decode(bytes.subarray(0, end));
}

/** UTF-8 byte length of a string. */
export function utf8ByteLength(input: string): number {
  return encoder.encode(input).length;
}
