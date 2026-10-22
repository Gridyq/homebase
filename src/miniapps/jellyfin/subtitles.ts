import type { BaseItem, MediaStream } from './api';

/** Subtitle index meaning "no subtitles", as Jellyfin expects it. */
export const SUBTITLES_OFF = -1;

export function subtitleStreams(item: BaseItem): MediaStream[] {
  return item.MediaSources?.[0]?.MediaStreams?.filter((s) => s.Type === 'Subtitle') ?? [];
}

/** The server's pick, based on the user's language preferences. */
export function defaultSubtitleIndex(item: BaseItem): number {
  return item.MediaSources?.[0]?.DefaultSubtitleStreamIndex ?? SUBTITLES_OFF;
}

export function subtitleLabel(stream: MediaStream) {
  return stream.DisplayTitle ?? stream.Language ?? `Track ${stream.Index}`;
}

/**
 * Carry a subtitle choice over to another item (e.g. the next episode): "off" stays off,
 * otherwise use the same language. Undefined means "let the server decide".
 */
export function subtitleLanguage(item: BaseItem, index: number | undefined) {
  if (index === undefined) return undefined;
  if (index === SUBTITLES_OFF) return 'off';
  return subtitleStreams(item).find((s) => s.Index === index)?.Language;
}

export function subtitleIndexForLanguage(item: BaseItem, language: string) {
  if (language === 'off') return SUBTITLES_OFF;
  const matches = subtitleStreams(item).filter((s) => s.Language === language);
  return (matches.find((s) => !s.IsForced) ?? matches[0])?.Index ?? SUBTITLES_OFF;
}
