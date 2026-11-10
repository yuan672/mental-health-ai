import sharp from 'sharp';
import { ValidationError } from '../common/errors';
import { photoMime } from './diary.schemas';

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
export async function normalizeAvatar(file: { buffer: Buffer; size: number }): Promise<Buffer> {
  if (!file.size || file.size !== file.buffer.length || file.size > MAX_AVATAR_BYTES)
    throw new ValidationError('请选择不超过 5 MB 的头像');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(photoMime(file.buffer) ?? ''))
    throw new ValidationError('头像支持 JPG、PNG 和 WebP 图片');
  try {
    return await sharp(file.buffer, { limitInputPixels: 16_000_000, failOn: 'warning' })
      .rotate()
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw new ValidationError('这张图片无法读取或尺寸过大，请换一张头像');
  }
}
