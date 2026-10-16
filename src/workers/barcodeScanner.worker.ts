import {
  BinaryBitmap,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library'

type MainToWorkerMessage = { type: 'frame'; bitmap: ImageBitmap }

type ScanResult = {
  barcode: string
  format: string
}

let canvas: OffscreenCanvas | null = null
const reader = new MultiFormatReader()

self.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
  if (event.data.type !== 'frame') return

  const { bitmap } = event.data

  try {
    if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    }

    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Could not initialize the barcode scanner canvas')

    context.drawImage(bitmap, 0, 0)
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height)
    const luminanceSource = new RGBLuminanceSource(
      imageData.data,
      imageData.width,
      imageData.height,
    )
    const binaryBitmap = new BinaryBitmap(new HybridBinarizer(luminanceSource))

    try {
      const result = reader.decode(binaryBitmap)
      const scanResult: ScanResult = {
        barcode: result.getText(),
        format: result.getBarcodeFormat().toString(),
      }
      self.postMessage({ type: 'frame-processed', result: scanResult })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      if (!['NotFoundException', 'ChecksumException', 'FormatException'].includes(name)) {
        throw error
      }
      self.postMessage({ type: 'frame-processed' })
    } finally {
      reader.reset()
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Barcode frame processing failed',
    })
  } finally {
    bitmap.close()
  }
}
