import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  useSpeechRecognition,
  type SpeechRecognitionAdapter,
  type SpeechRecognitionError,
  type SpeechRecognitionResult,
} from '@/composables/useSpeechRecognition'

function createAdapter() {
  let resultCallback: (result: SpeechRecognitionResult) => void = () => {}
  let errorCallback: (error: SpeechRecognitionError) => void = () => {}
  let endCallback: () => void = () => {}

  const adapter: SpeechRecognitionAdapter = {
    isSupported: () => true,
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    onResult: (callback) => {
      resultCallback = callback
    },
    onError: (callback) => {
      errorCallback = callback
    },
    onEnd: (callback) => {
      endCallback = callback
    },
  }

  return {
    adapter,
    emitResult: (result: SpeechRecognitionResult) => resultCallback(result),
    emitError: (error: SpeechRecognitionError) => errorCallback(error),
    emitEnd: () => endCallback(),
  }
}

describe('useSpeechRecognition watchdog', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops recognition and reports a manageable error after 8 seconds', async () => {
    vi.useFakeTimers()
    const mock = createAdapter()
    const speech = useSpeechRecognition(mock.adapter)

    await speech.startListening()
    vi.advanceTimersByTime(8000)

    expect(mock.adapter.stop).toHaveBeenCalledOnce()
    expect(speech.isListening.value).toBe(false)
    expect(speech.error.value).toEqual({
      code: 'unknown',
      message: 'Speech recognition timed out. Please try again.',
    })
  })

  it('restarts the watchdog after a result to detect a stalled recognition end', async () => {
    vi.useFakeTimers()
    const mock = createAdapter()
    const speech = useSpeechRecognition(mock.adapter)

    await speech.startListening()
    vi.advanceTimersByTime(6000)
    mock.emitResult({ transcript: 'milk', confidence: 0.9, isFinal: true })
    vi.advanceTimersByTime(7999)

    expect(speech.transcript.value).toBe('milk')
    expect(speech.isListening.value).toBe(true)
    expect(mock.adapter.stop).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(speech.isListening.value).toBe(false)
    expect(mock.adapter.stop).toHaveBeenCalledOnce()
  })

  it('clears the watchdog when recognition ends', async () => {
    vi.useFakeTimers()
    const mock = createAdapter()
    const speech = useSpeechRecognition(mock.adapter)

    await speech.startListening()
    mock.emitEnd()
    vi.advanceTimersByTime(8000)

    expect(speech.isListening.value).toBe(false)
    expect(speech.error.value).toBeNull()
    expect(mock.adapter.stop).not.toHaveBeenCalled()
  })

  it('clears the watchdog and resets listening state on recognition errors', async () => {
    vi.useFakeTimers()
    const mock = createAdapter()
    const speech = useSpeechRecognition(mock.adapter)
    const recognitionError: SpeechRecognitionError = {
      code: 'no-speech',
      message: 'No speech detected. Please try again.',
    }

    await speech.startListening()
    mock.emitError(recognitionError)
    vi.advanceTimersByTime(8000)

    expect(speech.isListening.value).toBe(false)
    expect(speech.error.value).toEqual(recognitionError)
    expect(mock.adapter.stop).not.toHaveBeenCalled()
  })
})
