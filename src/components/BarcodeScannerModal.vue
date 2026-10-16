<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, computed, nextTick } from 'vue'
import { useBarcodeScanner, type ScanResult } from '@/composables/useBarcodeScanner'
import { useCategoriesStore } from '@/stores/categories'
import { BaseDialog, BaseButton, BaseInput, CreateCategoryDialog } from '@/components'

interface Props {
  modelValue: boolean
}

interface Emits {
  (e: 'update:modelValue', value: boolean): void
  (e: 'scan', result: ScanResult): void
  (e: 'manual-entry', name: string, category: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const { isScanning, error, checkCamera, startScanning, stopScanning } = useBarcodeScanner()
const categoriesStore = useCategoriesStore()

const videoRef = ref<HTMLVideoElement | null>(null)
const cameraPermissionDenied = ref(false)
const barcodeNotRecognized = ref(false)
const lastScannedBarcode = ref('')
const showManualEntry = ref(false)
const showCreateCategory = ref(false)
const manualName = ref('')
const manualCategory = ref('other')

// Get all available categories (default + custom)
const categories = computed(() => {
  return categoriesStore.allCategories.map((cat) => ({
    value: cat.id,
    label: `${cat.icon} ${cat.name}`,
  }))
})

const handleClose = () => {
  emit('update:modelValue', false)
}

const handleScan = (result: ScanResult) => {
  // Reset error states and emit scan event
  barcodeNotRecognized.value = false
  lastScannedBarcode.value = result.barcode
  emit('scan', result)
  // Don't close modal here - let parent decide based on whether barcode was found
}

const handleBarcodeNotFound = () => {
  // Called by parent when barcode is not recognized
  barcodeNotRecognized.value = true
  stopScanning()
}

const handleTryAgain = async () => {
  // Reset error states and restart scanning
  barcodeNotRecognized.value = false
  lastScannedBarcode.value = ''
  await initializeScanner()
}

const handleManualEntry = () => {
  if (manualName.value.trim()) {
    emit('manual-entry', manualName.value.trim(), manualCategory.value)
    manualName.value = ''
    manualCategory.value = 'other'
    showManualEntry.value = false
    emit('update:modelValue', false)
  }
}

const handleCreateCategoryRequest = () => {
  showCreateCategory.value = true
}

const handleShowManualEntry = () => {
  stopScanning()
  showManualEntry.value = true
}

const handleBackToScanner = async () => {
  showManualEntry.value = false
  await nextTick()
  if (props.modelValue) await initializeScanner()
}

const handleCreateCategory = async (name: string, icon: string) => {
  const category = await categoriesStore.createCategory(name, icon)
  if (category) {
    manualCategory.value = category.id
    showCreateCategory.value = false
  }
}

const initializeScanner = async () => {
  await nextTick()
  cameraPermissionDenied.value = false
  barcodeNotRecognized.value = false
  error.value = null

  const hasCam = await checkCamera()
  if (!hasCam) {
    cameraPermissionDenied.value = true
    return
  }

  if (videoRef.value && props.modelValue) {
    try {
      await startScanning(videoRef.value, handleScan)
    } catch (err) {
      console.error('Scanner initialization error:', err)
      if (err instanceof Error) {
        // Check for permission-related errors
        if (
          err.name === 'NotAllowedError' ||
          err.name === 'PermissionDeniedError' ||
          err.message.includes('Permission') ||
          err.message.includes('permission')
        ) {
          cameraPermissionDenied.value = true
        } else {
          error.value = err.message || 'Failed to start camera'
        }
      } else {
        error.value = 'Failed to start camera'
      }
    }
  }
}

watch(
  () => props.modelValue,
  async (newValue) => {
    if (newValue) {
      showManualEntry.value = false
      await initializeScanner()
    } else {
      stopScanning()
    }
  },
)

onMounted(async () => {
  // Load custom categories from database
  await categoriesStore.loadCustomCategories()

  if (props.modelValue) {
    initializeScanner()
  }
})

onBeforeUnmount(() => {
  stopScanning()
})

// Expose method for parent to call when barcode not found
defineExpose({
  handleBarcodeNotFound,
  lastScannedBarcode,
})
</script>

<template>
  <BaseDialog :model-value="modelValue" @update:model-value="handleClose" size="large">
    <template #title>
      <span class="text-2xl">📷</span>
      Scan Barcode
    </template>

    <div class="min-h-[400px] flex flex-col">
      <!-- Camera View -->
      <div
        v-if="!showManualEntry"
        class="relative w-full h-[400px] bg-background-secondary rounded-xl overflow-hidden flex items-center justify-center"
      >
        <video
          v-show="!cameraPermissionDenied && !barcodeNotRecognized && !error"
          ref="videoRef"
          class="w-full h-full object-cover"
          autoplay
          playsinline
        ></video>

        <!-- Camera Permission Denied -->
        <div
          v-if="cameraPermissionDenied"
          class="flex flex-col items-center justify-center p-8 text-center"
        >
          <span class="text-6xl mb-4">📷</span>
          <h3 class="text-lg font-semibold mb-2">Camera Access Denied</h3>
          <p class="text-text-secondary text-center mb-4">
            Please allow camera access in your browser settings to scan barcodes.
          </p>
          <BaseButton @click="initializeScanner"> Try Again </BaseButton>
        </div>

        <!-- Barcode Not Recognized -->
        <div
          v-else-if="barcodeNotRecognized"
          class="flex flex-col items-center justify-center p-8 text-center"
        >
          <span class="text-6xl mb-4">❓</span>
          <h3 class="text-lg font-semibold mb-2">Barcode Not Recognized</h3>
          <p class="text-text-secondary text-center mb-4">
            This barcode is not in our database yet. You can try scanning again or enter the product
            details manually.
          </p>
          <div class="flex gap-3 mt-4">
            <BaseButton variant="secondary" @click="handleTryAgain" class="flex-1">
              Scan Again
            </BaseButton>
            <BaseButton @click="handleShowManualEntry" class="flex-1"> Enter Manually </BaseButton>
          </div>
        </div>

        <!-- Error State -->
        <div v-else-if="error" class="flex flex-col items-center justify-center p-8 text-center">
          <span class="text-6xl mb-4">⚠️</span>
          <h3 class="text-lg font-semibold mb-2">Scanner Error</h3>
          <p class="text-text-secondary text-center mb-4">
            {{ error }}
          </p>
          <BaseButton @click="initializeScanner"> Try Again </BaseButton>
        </div>

        <!-- Scanning Instructions -->
        <div
          v-else-if="isScanning"
          class="absolute inset-0 flex flex-col items-center justify-center bg-black/30 pointer-events-none"
        >
          <div
            class="scan-frame w-[250px] h-[250px] border-[3px] border-primary rounded-xl shadow-[0_0_0_9999px_rgba(0,0,0,0.5),0_0_20px_rgba(var(--color-primary-rgb),0.5)] animate-pulse-slow"
          ></div>
          <p
            class="mt-8 text-white text-base font-medium shadow-[0_2px_4px_rgba(0,0,0,0.5)] bg-black/60 px-4 py-2 rounded-lg"
          >
            Position barcode within the frame
          </p>
        </div>
      </div>

      <!-- Manual Entry Form -->
      <div v-else class="flex flex-col gap-6 py-4">
        <p class="text-text-secondary mb-4">
          Can't scan the barcode? Enter the product details manually:
        </p>

        <BaseInput
          v-model="manualName"
          label="Product Name"
          placeholder="Enter product name"
          required
        />

        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between mb-2">
            <label class="text-sm font-medium text-text">Category</label>
            <button
              type="button"
              @click="handleCreateCategoryRequest"
              class="text-sm text-primary hover:text-primary-dark font-medium"
            >
              + Create Category
            </button>
          </div>
          <select
            v-model="manualCategory"
            class="px-4 py-3 border-2 border-border rounded-lg text-base bg-background text-text cursor-pointer transition-all duration-200 hover:border-primary focus:outline-none focus:border-primary focus:shadow-[0_0_0_3px_rgba(var(--color-primary-rgb),0.1)]"
          >
            <option v-for="cat in categories" :key="cat.value" :value="cat.value">
              {{ cat.label }}
            </option>
          </select>
        </div>

        <div class="flex gap-3 mt-4">
          <BaseButton variant="secondary" @click="handleBackToScanner" class="flex-1">
            Back
          </BaseButton>
          <BaseButton @click="handleManualEntry" :disabled="!manualName.trim()" class="flex-1">
            Add Product
          </BaseButton>
        </div>
      </div>
    </div>

    <template #actions>
      <div class="flex gap-3 justify-end w-full">
        <BaseButton v-if="!showManualEntry" variant="secondary" @click="handleShowManualEntry">
          Enter Manually
        </BaseButton>
        <BaseButton variant="secondary" @click="handleClose"> Cancel </BaseButton>
      </div>
    </template>
  </BaseDialog>

  <!-- Create Category Dialog -->
  <CreateCategoryDialog v-model="showCreateCategory" @create="handleCreateCategory" />
</template>

<style scoped>
/* Custom pulse animation for scan frame */
@keyframes pulse-slow {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.6;
  }
}

.animate-pulse-slow {
  animation: pulse-slow 2s ease-in-out infinite;
}
</style>
