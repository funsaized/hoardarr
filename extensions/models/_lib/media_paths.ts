/** Shared media filename eligibility. */
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  "mkv",
  "mp4",
  "m4v",
  "avi",
  "mov",
  "webm",
  "ts",
  "m2ts",
  "mpg",
  "mpeg",
  "srt",
  "sub",
  "vtt",
  "ass",
  "ssa",
]);

/** Read a basename extension, ignoring dotfiles. */
export function extensionOf(name: string): string | null {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

/** Accept supported media and sidecar extensions only. */
export function isAllowedExtension(name: string): boolean {
  const ext = extensionOf(name);
  return ext !== null && ALLOWED_EXTENSIONS.has(ext);
}
