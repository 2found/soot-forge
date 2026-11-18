// Pictures a person sends a bot (channel-adapter v1.5 §13.3). A platform reports
// each picture as {ref, mime, name, size?} without downloading it; the inbound
// pipeline downloads them only when the session says binding.images and the chat
// is a DM, and sends them as images[]. How many is not bounded here: the host and
// the model's provider decide. Each one is bounded as the host bounds it.
export const PICTURE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const PICTURE_BYTES = 2 << 20;

export class PictureError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Downloads one picture through `get(ref)` → Response, bounded by PICTURE_BYTES.
export async function download(picture, get) {
  if (picture.size > PICTURE_BYTES) throw new PictureError('image_too_large');
  let response;
  try { response = await get(picture.ref); }
  catch (error) {
    if (error?.exitCode !== undefined || error?.tokenInvalid) throw error;
    throw new PictureError('image_unreadable');
  }
  if (!response?.ok) throw new PictureError('image_unreadable');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new PictureError('image_unreadable');
  if (bytes.length > PICTURE_BYTES) throw new PictureError('image_too_large');
  return {name: picture.name, mime: picture.mime, data: bytes.toString('base64')};
}
