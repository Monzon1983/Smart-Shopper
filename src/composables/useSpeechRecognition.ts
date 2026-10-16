import { ref } from 'vue'

// Type definitions for Web Speech API (not all browsers have it in TypeScript lib)
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList
  resultIndex: number
}

interface SpeechRecognitionResultList {
  length: number
  item(index: number): SpeechRecognitionResultItem
  [index: number]: SpeechRecognitionResultItem
}

interface SpeechRecognitionResultItem {
  length: number
  item(index: number): SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
  isFinal: boolean
}

interface SpeechRecognitionAlternative {
  transcript: string
  confidence: number
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string
  message: string
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognition
    webkitSpeechRecognition?: new () => SpeechRecognition
  }
}

/**
 * Speech recognition result (exported interface for the composable)
 */
export interface SpeechRecognitionResult {
  transcript: string
  confidence: number
  isFinal: boolean
}

/**
 * Speech recognition error types
 */
export type SpeechRecognitionErrorCode =
  | 'not-supported'
  | 'not-allowed'
  | 'no-speech'
  | 'aborted'
  | 'audio-capture'
  | 'network'
  | 'unknown'

export interface SpeechRecognitionError {
  code: SpeechRecognitionErrorCode
  message: string
}

/**
 * Adapter interface for speech recognition (enables mocking in tests)
 */
export interface SpeechRecognitionAdapter {
  isSupported: () => boolean
  start: () => Promise<void>
  stop: () => void
  onResult: (callback: (result: SpeechRecognitionResult) => void) => void
  onError: (callback: (error: SpeechRecognitionError) => void) => void
  onEnd: (callback: () => void) => void
}

/**
 * Browser-based speech recognition adapter using Web Speech API
 */
class BrowserSpeechRecognitionAdapter implements SpeechRecognitionAdapter {
  private recognition: SpeechRecognition | null = null
  private resultCallback: ((result: SpeechRecognitionResult) => void) | null = null
  private errorCallback: ((error: SpeechRecognitionError) => void) | null = null
  private endCallback: (() => void) | null = null

  isSupported(): boolean {
    return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.isSupported()) {
        const error: SpeechRecognitionError = {
          code: 'not-supported',
          message: 'Speech recognition is not supported in this browser',
        }
        this.errorCallback?.(error)
        reject(error)
        return
      }

      try {
        const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition
        if (!SpeechRecognitionAPI) {
          throw new Error('Speech recognition API not available')
        }

        this.recognition = new SpeechRecognitionAPI()

        // Configure recognition
        this.recognition.continuous = false // Stop after one sentence
        this.recognition.interimResults = true // Get partial results
        this.recognition.maxAlternatives = 1
        this.recognition.lang = 'en-US'

        // Handle results
        this.recognition.onresult = (event: SpeechRecognitionEvent) => {
          const result = event.results[event.results.length - 1]
          if (!result) return

          const transcript = result[0]?.transcript || ''
          const confidence = result[0]?.confidence || 0
          const isFinal = result.isFinal

          this.resultCallback?.({
            transcript,
            confidence,
            isFinal,
          })
        }

        // Handle errors
        this.recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
          const errorCode = this.mapErrorCode(event.error)
          const error: SpeechRecognitionError = {
            code: errorCode,
            message: this.getErrorMessage(errorCode),
          }
          this.errorCallback?.(error)
        }

        // Handle end
        this.recognition.onend = () => {
          this.endCallback?.()
        }

        // Start recognition
        this.recognition.start()
        resolve()
      } catch (error) {
        const speechError: SpeechRecognitionError = {
          code: 'unknown',
          message: error instanceof Error ? error.message : 'Unknown error occurred',
        }
        this.errorCallback?.(speechError)
        reject(speechError)
      }
    })
  }

  stop(): void {
    if (this.recognition) {
      this.recognition.stop()
    }
  }

  onResult(callback: (result: SpeechRecognitionResult) => void): void {
    this.resultCallback = callback
  }

  onError(callback: (error: SpeechRecognitionError) => void): void {
    this.errorCallback = callback
  }

  onEnd(callback: () => void): void {
    this.endCallback = callback
  }

  private mapErrorCode(errorType: string): SpeechRecognitionErrorCode {
    switch (errorType) {
      case 'not-allowed':
      case 'permission-denied':
        return 'not-allowed'
      case 'no-speech':
        return 'no-speech'
      case 'aborted':
        return 'aborted'
      case 'audio-capture':
        return 'audio-capture'
      case 'network':
        return 'network'
      default:
        return 'unknown'
    }
  }

  private getErrorMessage(code: SpeechRecognitionErrorCode): string {
    switch (code) {
      case 'not-supported':
        return 'Speech recognition is not supported in this browser'
      case 'not-allowed':
        return 'Microphone permission denied. Please allow microphone access to use voice input.'
      case 'no-speech':
        return 'No speech detected. Please try again.'
      case 'aborted':
        return 'Speech recognition was aborted'
      case 'audio-capture':
        return 'Microphone not available. Please check your device settings.'
      case 'network':
        return 'Network error. Please check your internet connection.'
      default:
        return 'An error occurred during speech recognition'
    }
  }
}

/**
 * Composable for speech recognition
 */
export function useSpeechRecognition(adapter?: SpeechRecognitionAdapter) {
  const recognitionAdapter = adapter || new BrowserSpeechRecognitionAdapter()

  const isListening = ref(false)
  const transcript = ref('')
  const error = ref<SpeechRecognitionError | null>(null)
  const isSupported = ref(recognitionAdapter.isSupported())
  const WATCHDOG_TIMEOUT_MS = 8000
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null

  const clearWatchdog = () => {
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
  }

  const startWatchdog = () => {
    clearWatchdog()
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null
      if (!isListening.value) return

      isListening.value = false
      try {
        recognitionAdapter.stop()
      } catch (stopError) {
        console.error('Failed to stop timed-out speech recognition:', stopError)
      }
      error.value = {
        code: 'unknown',
        message: 'Speech recognition timed out. Please try again.',
      }
    }, WATCHDOG_TIMEOUT_MS)
  }

  // Set up callbacks
  recognitionAdapter.onResult((result) => {
    clearWatchdog()
    transcript.value = result.transcript
    error.value = null
    if (isListening.value) startWatchdog()
  })

  recognitionAdapter.onError((err) => {
    clearWatchdog()
    error.value = err
    isListening.value = false
  })

  recognitionAdapter.onEnd(() => {
    clearWatchdog()
    isListening.value = false
  })

  const startListening = async () => {
    if (!isSupported.value) {
      error.value = {
        code: 'not-supported',
        message: 'Speech recognition is not supported in this browser',
      }
      return
    }

    try {
      transcript.value = ''
      error.value = null
      isListening.value = true
      startWatchdog()
      await recognitionAdapter.start()
    } catch (err) {
      clearWatchdog()
      isListening.value = false
      error.value = {
        code: 'unknown',
        message: err instanceof Error ? err.message : 'Failed to start speech recognition',
      }
      console.error('Failed to start speech recognition:', err)
    }
  }

  const stopListening = () => {
    clearWatchdog()
    recognitionAdapter.stop()
    isListening.value = false
  }

  const reset = () => {
    clearWatchdog()
    transcript.value = ''
    error.value = null
    isListening.value = false
  }

  return {
    isListening,
    transcript,
    error,
    isSupported,
    startListening,
    stopListening,
    reset,
  }
}
