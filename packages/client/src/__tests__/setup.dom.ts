/**
 * DOM environment setup for bun:test.
 * Registers happy-dom globals (document, window, etc.) before each test file
 * that needs React rendering.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
