import type { MessageImage } from './ai'

/**
 * 채팅에 넣을 이미지 처리
 *
 * Claude 가 받는 형식(PNG, JPEG, GIF, WebP)만 허용하고, 긴 변이 MAX_EDGE 를 넘으면 브라우저에서 줄여 base64 로 만든다.
 * 형식이 다르거나 읽기·변환에 실패하면 사용자에게 보여줄 한국어 메시지로 Error 를 던진다.
 */

export const MAX_IMAGES_PER_MESSAGE = 5
// Claude 는 긴 변이 1568px 를 넘는 이미지를 내부에서 줄인다. 미리 줄이면 화질 손해 없이 토큰·전송량만 준다.
const MAX_EDGE = 1568
// Claude API 의 이미지 1장 크기 한도(5MB)
const MAX_BYTES = 5 * 1024 * 1024
const SUPPORTED: MessageImage['mediaType'][] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
// 투명도가 없는 형식으로 줄일 때 쓰는 JPEG 품질
const JPEG_QUALITY = 0.9

function isSupported(type: string): type is MessageImage['mediaType'] {
  return (SUPPORTED as string[]).includes(type)
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    // data:<type>;base64,<data> 에서 data 부분만 쓴다.
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function readImage(file: File): Promise<MessageImage> {
  if (!isSupported(file.type)) throw new Error('이미지(PNG, JPG, GIF, WebP)만 넣을 수 있어요')

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(`이미지를 읽지 못했어요: ${file.name}`)
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))

  // 줄일 필요가 없으면 원본을 그대로 쓴다(GIF 애니메이션도 유지된다).
  if (scale === 1 && file.size <= MAX_BYTES) {
    bitmap.close()
    return { mediaType: file.type, data: await blobToBase64(file) }
  }

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  // PNG 는 투명도를 지키기 위해 PNG 로, 나머지(GIF 는 첫 프레임)는 JPEG 로 다시 만든다.
  const mediaType: MessageImage['mediaType'] = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mediaType, JPEG_QUALITY))
  if (!blob) throw new Error(`이미지를 변환하지 못했어요: ${file.name}`)
  if (blob.size > MAX_BYTES) throw new Error(`이미지가 너무 커요(5MB 초과): ${file.name}`)
  return { mediaType, data: await blobToBase64(blob) }
}

export function imageSrc(image: MessageImage): string {
  return `data:${image.mediaType};base64,${image.data}`
}
