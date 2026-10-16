import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useBackup } from '@/composables/useBackup'
import { useListsStore } from '@/stores/lists'
import { useItemsStore } from '@/stores/items'
import type { BackupData } from '@/composables/useBackup'
import { db } from '@/db'

describe('Rule 2.3: Local backup and restore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('Backup Export', () => {
    it('should export lists to backup data', async () => {
      const listsStore = useListsStore()
      const itemsStore = useItemsStore()
      const backup = useBackup()

      await listsStore.loadLists()

      // Create a list with items
      const list = await listsStore.createList('Grocery List')
      await itemsStore.createItem(list.id, 'Milk', 'dairy')
      await itemsStore.createItem(list.id, 'Bread', 'bakery')

      // Export backup
      const backupData = await backup.exportBackup()

      expect(backupData).toBeDefined()
      expect(backupData.version).toBeDefined()
      expect(backupData.timestamp).toBeGreaterThan(0)
      expect(backupData.lists).toBeDefined()
      expect(backupData.items).toBeDefined()
      expect(Array.isArray(backupData.lists)).toBe(true)
      expect(Array.isArray(backupData.items)).toBe(true)
    })

    it('should include all items in backup', async () => {
      const listsStore = useListsStore()
      const itemsStore = useItemsStore()
      const backup = useBackup()

      await listsStore.loadLists()

      const list = await listsStore.createList('Test List')
      await itemsStore.createItem(list.id, 'Item 1', 'other')
      await itemsStore.createItem(list.id, 'Item 2', 'other')
      await itemsStore.createItem(list.id, 'Item 3', 'other')

      const backupData = await backup.exportBackup()

      const exportedList = backupData.lists.find((l) => l.id === list.id)
      expect(exportedList).toBeDefined()

      const exportedItems = backupData.items.filter((i) => i.listId === list.id)
      expect(exportedItems).toHaveLength(3)
    })

    it('should preserve item categories in backup', async () => {
      const listsStore = useListsStore()
      const itemsStore = useItemsStore()
      const backup = useBackup()

      await listsStore.loadLists()

      const list = await listsStore.createList('Category Test')
      await itemsStore.createItem(list.id, 'Milk', 'dairy')
      await itemsStore.createItem(list.id, 'Apples', 'produce')
      await itemsStore.createItem(list.id, 'Bread', 'bakery')

      const backupData = await backup.exportBackup()

      const items = backupData.items.filter((i) => i.listId === list.id)
      expect(items.find((i) => i.name === 'Milk')?.category).toBe('dairy')
      expect(items.find((i) => i.name === 'Apples')?.category).toBe('produce')
      expect(items.find((i) => i.name === 'Bread')?.category).toBe('bakery')
    })

    it('should preserve completed state in backup', async () => {
      const listsStore = useListsStore()
      const itemsStore = useItemsStore()
      const backup = useBackup()

      await listsStore.loadLists()

      const list = await listsStore.createList('Completion Test')
      const item1 = await itemsStore.createItem(list.id, 'Completed Item', 'other')
      const item2 = await itemsStore.createItem(list.id, 'Incomplete Item', 'other')

      // Mark one as completed
      await itemsStore.updateItem(list.id, item1.id, { completed: true })
      await itemsStore.loadItems(list.id)

      const backupData = await backup.exportBackup()

      const items = backupData.items.filter((i) => i.listId === list.id)
      expect(items.find((i) => i.id === item1.id)?.completed).toBe(true)
      expect(items.find((i) => i.id === item2.id)?.completed).toBe(false)
    })
  })

  describe('Backup Validation', () => {
    it('should validate correct backup data', () => {
      const backup = useBackup()

      const validBackup: BackupData = {
        version: '1.0.0',
        timestamp: Date.now(),
        lists: [],
        items: [],
        customCategories: [],
        products: [],
        categoryPreferences: {},
        categoryOrder: [],
      }

      const result = backup.validateBackup(validBackup)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('should reject invalid backup data', () => {
      const backup = useBackup()

      const invalidBackup = {
        // Missing required fields
        version: '1.0.0',
        // No timestamp, lists, items, etc.
      }

      const result = backup.validateBackup(invalidBackup)
      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
    })

    it('should reject incompatible backup versions', () => {
      const backup = useBackup()

      const incompatibleBackup: BackupData = {
        version: '2.0.0', // Future version
        timestamp: Date.now(),
        lists: [],
        items: [],
        customCategories: [],
        products: [],
        categoryPreferences: {},
        categoryOrder: [],
      }

      const result = backup.validateBackup(incompatibleBackup)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes('Incompatible'))).toBe(true)
    })

    it('should validate required fields', () => {
      const backup = useBackup()

      const result = backup.validateBackup(null)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes('must be an object'))).toBe(true)
    })
  })

  describe('Backup Restore', () => {
    it('should merge records by key and prefer the newer timestamp', async () => {
      const backup = useBackup()
      const localList = {
        id: 'list-1',
        name: 'Local newer list',
        createdAt: 1,
        updatedAt: 300,
        archived: false,
      }
      const localItem = {
        id: 'item-1',
        listId: 'list-1',
        name: 'Local newer item',
        quantity: 1,
        category: 'other',
        completed: false,
        addedAt: 300,
      }
      const localCategory = {
        id: 'custom-category',
        name: 'Local category',
        sortOrder: 1,
      }
      const localProduct = {
        barcode: '12345678',
        name: 'Local newer product',
        category: 'other',
        lastUsed: 300,
      }

      await db.lists.add(localList)
      await db.items.add(localItem)
      await db.categories.add(localCategory)
      await db.products.add(localProduct)

      const backupData: BackupData = {
        version: '1.0.0',
        timestamp: Date.now(),
        lists: [
          { ...localList, name: 'Older imported list', updatedAt: 200 },
          {
            id: 'list-2',
            name: 'New imported list',
            createdAt: 100,
            updatedAt: 200,
            archived: false,
          },
        ],
        items: [
          { ...localItem, name: 'Older imported item', addedAt: 200 },
          {
            id: 'item-2',
            listId: 'list-2',
            name: 'New imported item',
            quantity: 1,
            category: 'other',
            completed: false,
            addedAt: 200,
          },
        ],
        customCategories: [
          { ...localCategory, name: 'Imported category without timestamp' },
          { id: 'category-2', name: 'New category', sortOrder: 2 },
        ],
        products: [
          { ...localProduct, name: 'Older imported product', lastUsed: 200 },
          {
            barcode: '87654321',
            name: 'New imported product',
            category: 'other',
            lastUsed: 200,
          },
        ],
        categoryPreferences: {},
        categoryOrder: [],
      }

      await backup.importBackup(backupData, { merge: true })

      expect(await db.lists.get('list-1')).toMatchObject({ name: 'Local newer list' })
      expect(await db.lists.get('list-2')).toMatchObject({ name: 'New imported list' })
      expect(await db.items.get('item-1')).toMatchObject({ name: 'Local newer item' })
      expect(await db.items.get('item-2')).toMatchObject({ name: 'New imported item' })
      expect(await db.categories.get('custom-category')).toMatchObject({
        name: 'Local category',
      })
      expect(await db.categories.get('category-2')).toMatchObject({ name: 'New category' })
      expect(await db.products.get('12345678')).toMatchObject({
        name: 'Local newer product',
      })
      expect(await db.products.get('87654321')).toMatchObject({
        name: 'New imported product',
      })
      expect(await db.lists.count()).toBe(2)
      expect(await db.items.count()).toBe(2)
      expect(await db.categories.count()).toBe(2)
      expect(await db.products.count()).toBe(2)
    })

    it('should replace records with newer imported timestamps', async () => {
      const backup = useBackup()
      await db.lists.add({
        id: 'list-1',
        name: 'Local older list',
        createdAt: 1,
        updatedAt: 100,
        archived: false,
      })

      const backupData: BackupData = {
        version: '1.0.0',
        timestamp: Date.now(),
        lists: [
          {
            id: 'list-1',
            name: 'Newer imported list',
            createdAt: 1,
            updatedAt: 200,
            archived: true,
          },
        ],
        items: [],
        customCategories: [],
        products: [],
        categoryPreferences: {},
        categoryOrder: [],
      }

      await backup.importBackup(backupData, { merge: true })

      expect(await db.lists.get('list-1')).toMatchObject({
        name: 'Newer imported list',
        updatedAt: 200,
        archived: true,
      })
      expect(await db.lists.count()).toBe(1)
    })

    it('should restore lists from backup', async () => {
      const listsStore = useListsStore()
      const itemsStore = useItemsStore()
      const backup = useBackup()

      await listsStore.loadLists()

      // Create original data
      const originalList = await listsStore.createList('Original List')
      await itemsStore.createItem(originalList.id, 'Original Item', 'other')

      // Export backup
      const backupData = await backup.exportBackup()

      // Clear data
      await listsStore.deleteList(originalList.id)
      await listsStore.loadLists()
      expect(listsStore.lists).toHaveLength(0)

      // Restore from backup
      await backup.importBackup(backupData)

      // Verify restoration
      await listsStore.loadLists()
      expect(listsStore.lists.length).toBeGreaterThan(0)

      const restoredList = listsStore.lists.find((l) => l.name === 'Original List')
      expect(restoredList).toBeDefined()
    })

    it('should restore items with categories', async () => {
      const listsStore = useListsStore()
      const itemsStore = useItemsStore()
      const backup = useBackup()

      await listsStore.loadLists()

      // Create list with categorized items
      const list = await listsStore.createList('Categorized List')
      await itemsStore.createItem(list.id, 'Milk', 'dairy')
      await itemsStore.createItem(list.id, 'Bread', 'bakery')

      // Export backup
      const backupData = await backup.exportBackup()

      // Clear and restore
      await listsStore.deleteList(list.id)
      await backup.importBackup(backupData)

      // Verify items were restored with categories
      await listsStore.loadLists()
      const restoredList = listsStore.lists.find((l) => l.name === 'Categorized List')
      expect(restoredList).toBeDefined()

      await itemsStore.loadItems(restoredList!.id)
      const items = itemsStore.getItemsByListId(restoredList!.id).value

      expect(items.find((i) => i.name === 'Milk')?.category).toBe('dairy')
      expect(items.find((i) => i.name === 'Bread')?.category).toBe('bakery')
    })

    it('should restore completed state of items', async () => {
      const listsStore = useListsStore()
      const itemsStore = useItemsStore()
      const backup = useBackup()

      await listsStore.loadLists()

      // Create list with completed item
      const list = await listsStore.createList('Completion List')
      const item = await itemsStore.createItem(list.id, 'Completed Item', 'other')
      await itemsStore.updateItem(list.id, item.id, { completed: true })

      // Export, clear, restore
      const backupData = await backup.exportBackup()
      await listsStore.deleteList(list.id)
      await backup.importBackup(backupData)

      // Verify completed state
      await listsStore.loadLists()
      const restoredList = listsStore.lists.find((l) => l.name === 'Completion List')

      await itemsStore.loadItems(restoredList!.id)
      const items = itemsStore.getItemsByListId(restoredList!.id).value

      expect(items).toHaveLength(1)
      expect(items[0]?.completed).toBe(true)
    })

    it('should handle restore errors gracefully', async () => {
      const backup = useBackup()

      const invalidBackup = {
        version: '1.0.0',
        timestamp: Date.now(),
        // Missing required arrays
      } as unknown as BackupData

      await expect(backup.importBackup(invalidBackup)).rejects.toThrow()
    })
  })
})
