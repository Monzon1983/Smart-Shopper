import { ref } from 'vue'

export interface ScanResult {
  barcode: string
  format: string
}

export interface BarcodeScannerAdapter {
  startScanning(
    videoElement: HTMLVideoElement,
    onDetected: (result: ScanResult) => void,
    onError?: (error: Error) => void,
  ): Promise<void>
  stopScanning(): void
  hasCamera(): Promise<boolean>
}

type WorkerToMainMessage =
  | { type: 'frame-processed'; result?: ScanResult }
  | { type: 'error'; message: string }

class ZXingScanner implements BarcodeScannerAdapter {
  private scanning = false
  private sessionId = 0
  private stream: MediaStream | null = null
  private videoElement: HTMLVideoElement | null = null
  private worker: Worker | null = null
  private animationFrameId: number | null = null
  private framePending = false
  private lastFrameSentAt = 0
  private onError: ((error: Error) => void) | undefined

  async hasCamera(): Promise<boolean> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      return devices.some((device) => device.kind === 'videoinput')
    } catch {
      return false
    }
  }

  async startScanning(
    videoElement: HTMLVideoElement,
    onDetected: (result: ScanResult) => void,
    onError?: (error: Error) => void,
  ): Promise<void> {
    if (this.scanning) return

    this.scanning = true
    this.onError = onError
    const sessionId = ++this.sessionId

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera access is not supported by this browser')
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      })

      if (!this.scanning || sessionId !== this.sessionId) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      this.stream = stream
      this.videoElement = videoElement
      videoElement.srcObject = stream
      await videoElement.play()

      if (!this.scanning || sessionId !== this.sessionId) return

      const worker = new Worker(new URL('../workers/barcodeScanner.worker.ts', import.meta.url), {
        type: 'module',
      })
      this.worker = worker
      worker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
        if (!this.scanning || sessionId !== this.sessionId) return

        if (event.data.type === 'error') {
          this.fail(new Error(event.data.message), sessionId)
          return
        }

        this.framePending = false
        if (event.data.result) onDetected(event.data.result)
      }
      worker.onerror = (event) => {
        event.preventDefault()
        this.fail(new Error(event.message || 'Barcode scanner worker failed'), sessionId)
      }
      worker.onmessageerror = () => {
        this.fail(new Error('Could not read a message from the barcode scanner worker'), sessionId)
      }

      this.scanFrames(sessionId)
    } catch (error) {
      this.stopScanning()
      throw error
    }
  }

  stopScanning(): void {
    this.sessionId++
    this.scanning = false
    this.framePending = false
    this.onError = undefined

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }

    this.worker?.terminate()
    this.worker = null

    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null

    if (this.videoElement) this.videoElement.srcObject = null
    this.videoElement = null
    this.lastFrameSentAt = 0
  }

  private scanFrames(sessionId: number): void {
    const videoElement = this.videoElement
    if (!videoElement) return

    const captureFrame = async (timestamp: number) => {
      if (!this.scanning || sessionId !== this.sessionId) return

      this.animationFrameId = requestAnimationFrame(captureFrame)

      if (
        this.framePending ||
        timestamp - this.lastFrameSentAt < 100 ||
        videoElement.readyState < 2 ||
        !this.worker
      ) {
        return
      }

      this.lastFrameSentAt = timestamp
      this.framePending = true
      try {
        const bitmap = await createImageBitmap(videoElement)
        if (!this.scanning || sessionId !== this.sessionId) {
          bitmap.close()
          return
        }
        this.worker?.postMessage({ type: 'frame', bitmap }, [bitmap])
      } catch (error) {
        this.fail(
          error instanceof Error ? error : new Error('Could not capture a camera frame'),
          sessionId,
        )
      }
    }

    this.animationFrameId = requestAnimationFrame(captureFrame)
  }

  private fail(error: Error, sessionId: number): void {
    if (!this.scanning || sessionId !== this.sessionId) return
    const onError = this.onError
    this.stopScanning()
    onError?.(error)
  }
}

class MockScanner implements BarcodeScannerAdapter {
  private mockResults: ScanResult[] = []
  private mockHasCamera = true

  setMockResults(results: ScanResult[]): void {
    this.mockResults = results
  }

  setMockHasCamera(hasCamera: boolean): void {
    this.mockHasCamera = hasCamera
  }

  async hasCamera(): Promise<boolean> {
    return this.mockHasCamera
  }

  async startScanning(
    _videoElement: HTMLVideoElement,
    onDetected: (result: ScanResult) => void,
  ): Promise<void> {
    // Simulate scanning by calling onDetected with mock results after a delay
    if (this.mockResults.length > 0) {
      setTimeout(() => {
        this.mockResults.forEach((result) => onDetected(result))
      }, 100)
    }
  }

  stopScanning(): void {
    // Nothing to do for mock
  }
}

let scannerAdapter: BarcodeScannerAdapter | null = null

/**
 * Set a custom scanner adapter (useful for testing)
 */
export function setScannerAdapter(adapter: BarcodeScannerAdapter): void {
  scannerAdapter = adapter
}

/**
 * Get the scanner adapter (creates ZXing scanner by default)
 */
function getScannerAdapter(): BarcodeScannerAdapter {
  if (!scannerAdapter) {
    scannerAdapter = new ZXingScanner()
  }
  return scannerAdapter
}

/**
 * Composable for barcode scanning
 */
export function useBarcodeScanner() {
  const isScanning = ref(false)
  const error = ref<string | null>(null)
  const hasCamera = ref(true)

  const adapter = getScannerAdapter()

  const checkCamera = async (): Promise<boolean> => {
    const result = await adapter.hasCamera()
    hasCamera.value = result
    return result
  }

  const startScanning = async (
    videoElement: HTMLVideoElement,
    onDetected: (result: ScanResult) => void,
  ) => {
    try {
      error.value = null
      isScanning.value = true
      await adapter.startScanning(
        videoElement,
        (result) => {
          onDetected(result)
        },
        (scannerError) => {
          error.value = scannerError.message
          isScanning.value = false
        },
      )
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to start scanning'
      isScanning.value = false
      throw err
    }
  }

  const stopScanning = () => {
    adapter.stopScanning()
    isScanning.value = false
  }

  return {
    isScanning,
    error,
    hasCamera,
    checkCamera,
    startScanning,
    stopScanning,
  }
}

// Export mock scanner for testing
export { MockScanner }
