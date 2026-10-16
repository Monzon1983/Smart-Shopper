import { useListsStore } from '@/stores/lists'
import { useItemsStore } from '@/stores/items'
import { useCategoriesStore } from '@/stores/categories'
import { useProductsStore } from '@/stores/products'
import { db, type Category, type Product, type ShoppingItem, type ShoppingList } from '@/db'

export interface BackupData {
  version: string
  timestamp: number
  lists: ShoppingList[]
  items: ShoppingItem[]
  customCategories: Category[]
  products: Product[]
  categoryPreferences: Record<string, string>
  categoryOrder: string[]
}

export interface BackupValidationResult {
  valid: boolean
  errors: string[]
}

const getRecordTimestamp = (record: object): number | undefined => {
  const timestampKeys = new Set([
    'updatedAt',
    'lastUsed',
    'completedAt',
    'addedAt',
    'createdAt',
    'learnedAt',
  ])
  const timestamps: number[] = []
  for (const [key, value] of Object.entries(record)) {
    if (timestampKeys.has(key) && typeof value === 'number' && Number.isFinite(value)) {
      timestamps.push(value)
    }
  }

  return timestamps.length > 0 ? Math.max(...timestamps) : undefined
}

const upsertNewerRecords = async <T extends object>(
  records: T[],
  getExisting: (key: string) => Promise<T | undefined>,
  save: (record: T) => Promise<unknown>,
  getKey: (record: T) => string,
): Promise<void> => {
  for (const incoming of records) {
    const incomingRecord = { ...incoming }
    const existing = await getExisting(getKey(incomingRecord))
    if (!existing) {
      await save(incomingRecord)
      continue
    }

    const incomingTimestamp = getRecordTimestamp(incomingRecord)
    const localTimestamp = getRecordTimestamp(existing)
    if (
      incomingTimestamp !== undefined &&
      (localTimestamp === undefined || incomingTimestamp > localTimestamp)
    ) {
      await save(incomingRecord)
    }
  }
}

/**
 * Composable for backing up and restoring application data
 */
export function useBackup() {
  const listsStore = useListsStore()
  const itemsStore = useItemsStore()
  const categoriesStore = useCategoriesStore()
  const productsStore = useProductsStore()

  /**
   * Export all application data to a backup object
   */
  const exportBackup = async (): Promise<BackupData> => {
    // Load all data from stores
    await listsStore.loadLists()
    await productsStore.loadProducts()
    await categoriesStore.loadCustomCategories()

    // Load all items for all lists
    const allItems: ShoppingItem[] = []
    for (const list of listsStore.lists) {
      await itemsStore.loadItems(list.id)
      const listItems = itemsStore.getItemsByListId(list.id).value
      allItems.push(...listItems)
    }

    // Get category preferences from localStorage
    const categoryPreferences: Record<string, string> = {}
    try {
      const stored = localStorage.getItem('categoryPreferences')
      if (stored) {
        Object.assign(categoryPreferences, JSON.parse(stored))
      }
    } catch (error) {
      console.error('Failed to load category preferences:', error)
    }

    // Get category order from localStorage
    let categoryOrder: string[] = []
    try {
      const stored = localStorage.getItem('categoryOrder')
      if (stored) {
        categoryOrder = JSON.parse(stored)
      }
    } catch (error) {
      console.error('Failed to load category order:', error)
    }

    return {
      version: '1.0.0',
      timestamp: Date.now(),
      lists: listsStore.lists,
      items: allItems,
      customCategories: categoriesStore.customCategories,
      products: productsStore.products,
      categoryPreferences,
      categoryOrder,
    }
  }

  /**
   * Download backup data as a JSON file
   */
  const downloadBackup = async (): Promise<void> => {
    const backup = await exportBackup()
    const json = JSON.stringify(backup, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const timestamp = new Date().toISOString().split('T')[0]
    const filename = `shopping-list-backup-${timestamp}.json`

    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  /**
   * Validate backup data structure
   */
  const validateBackup = (data: unknown): BackupValidationResult => {
    const errors: string[] = []

    if (!data || typeof data !== 'object') {
      errors.push('Backup data must be an object')
      return { valid: false, errors }
    }

    const backup = data as Partial<BackupData>

    // Check required fields
    if (!backup.version) {
      errors.push('Missing version field')
    }

    if (typeof backup.timestamp !== 'number') {
      errors.push('Missing or invalid timestamp field')
    }

    if (!Array.isArray(backup.lists)) {
      errors.push('Missing or invalid lists array')
    }

    if (!Array.isArray(backup.items)) {
      errors.push('Missing or invalid items array')
    }

    if (!Array.isArray(backup.customCategories)) {
      errors.push('Missing or invalid customCategories array')
    }

    if (!Array.isArray(backup.products)) {
      errors.push('Missing or invalid products array')
    }

    // Validate version compatibility
    if (backup.version && !backup.version.startsWith('1.')) {
      errors.push(`Incompatible backup version: ${backup.version}`)
    }

    return {
      valid: errors.length === 0,
      errors,
    }
  }

  /**
   * Import backup data and restore to database
   */
  const importBackup = async (
    backupData: BackupData,
    options: { merge?: boolean } = {},
  ): Promise<void> => {
    const { merge = false } = options

    // Validate backup first
    const validation = validateBackup(backupData)
    if (!validation.valid) {
      throw new Error(`Invalid backup: ${validation.errors.join(', ')}`)
    }

    await db.transaction('rw', db.lists, db.items, db.categories, db.products, async () => {
      if (merge) {
        await upsertNewerRecords(
          backupData.lists,
          (id) => db.lists.get(id),
          (list) => db.lists.put(list),
          (list) => list.id,
        )
        await upsertNewerRecords(
          backupData.items,
          (id) => db.items.get(id),
          (item) => db.items.put(item),
          (item) => item.id,
        )
        await upsertNewerRecords(
          backupData.customCategories,
          (id) => db.categories.get(id),
          (category) => db.categories.put(category),
          (category) => category.id,
        )
        await upsertNewerRecords(
          backupData.products,
          (barcode) => db.products.get(barcode),
          (product) => db.products.put(product),
          (product) => product.barcode,
        )
        return
      }

      await db.lists.clear()
      await db.items.clear()
      await db.categories.clear()
      await db.products.clear()
      await db.lists.bulkPut(backupData.lists.map((list) => ({ ...list })))
      await db.items.bulkPut(backupData.items.map((item) => ({ ...item })))
      await db.categories.bulkPut(backupData.customCategories.map((category) => ({ ...category })))
      await db.products.bulkPut(backupData.products.map((product) => ({ ...product })))
    })

    // Restore category preferences to localStorage
    if (backupData.categoryPreferences) {
      try {
        localStorage.setItem('categoryPreferences', JSON.stringify(backupData.categoryPreferences))
      } catch (error) {
        console.error('Failed to restore category preferences:', error)
      }
    }

    // Restore category order to localStorage
    if (backupData.categoryOrder && backupData.categoryOrder.length > 0) {
      try {
        categoriesStore.saveCategoryOrder(backupData.categoryOrder)
      } catch (error) {
        console.error('Failed to restore category order:', error)
      }
    }

    // Reload all stores to reflect the restored data
    await listsStore.loadLists()
    itemsStore.items.clear()
    for (const list of listsStore.lists) {
      await itemsStore.loadItems(list.id)
    }
    await productsStore.loadProducts()
    await categoriesStore.loadCustomCategories()
  }

  /**
   * Import backup from a file
   */
  const importBackupFromFile = async (
    file: File,
    options: { merge?: boolean } = {},
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()

      reader.onload = async (e) => {
        try {
          const content = e.target?.result as string
          const backupData = JSON.parse(content) as BackupData
          await importBackup(backupData, options)
          resolve()
        } catch (error) {
          if (error instanceof Error) {
            reject(new Error(`Failed to import backup: ${error.message}`))
          } else {
            reject(new Error('Failed to import backup: Unknown error'))
          }
        }
      }

      reader.onerror = () => {
        reject(new Error('Failed to read backup file'))
      }

      reader.readAsText(file)
    })
  }

  return {
    exportBackup,
    downloadBackup,
    validateBackup,
    importBackup,
    importBackupFromFile,
  }
}
