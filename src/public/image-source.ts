/**
 * Where the page loads an image from: the server link that history images
 * carry, or the image's own base64 data.
 */

export type ImageBlock = {
  url?: unknown;
  data?: unknown;
  mimeType?: unknown;
  media_type?: unknown;
  source?: { data?: unknown; media_type?: unknown };
};

// Only links the server makes for history images are used as they are.
const HISTORY_IMAGE_LINK = /^\/api\/live-sessions\/[\w.%~-]+\/images\/\d+\/\d+\/\d+$/;

export function imageSource(image: ImageBlock): string | null {
  if (typeof image.url === 'string') return HISTORY_IMAGE_LINK.test(image.url) ? image.url : null;
  const data = typeof image.data === 'string' ? image.data : typeof image.source?.data === 'string' ? image.source.data : '';
  if (!data) return null;
  if (data.startsWith('data:')) return data;
  const mimeType = [image.mimeType, image.source?.media_type, image.media_type].find((value): value is string => typeof value === 'string');
  return `data:${mimeType || 'image/png'};base64,${data}`;
}
