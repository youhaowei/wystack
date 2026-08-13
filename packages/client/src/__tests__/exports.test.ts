import { describe, expect, test } from 'bun:test'
import * as root from '@wystack/client'
import * as core from '@wystack/client/core'
import * as react from '@wystack/client/react'
import * as web from '@wystack/client/web'
import * as electron from '@wystack/client/electron'

describe('public client entrypoints', () => {
  test('keeps the root web + React facade backward compatible', () => {
    expect(Object.keys(root).sort()).toEqual([
      'CallNotReadyError',
      'WyStackProvider',
      'createApi',
      'createClient',
      'createElectronPipe',
      'createEngine',
      'createIpcManager',
      'createReactBindings',
      'createWebSocketPipe',
      'createWsManager',
      'createWyStack',
      'useAction',
      'useMutation',
      'useQuery',
      'useWyStackClient',
    ])
  })

  test('exposes focused platform entrypoints', () => {
    expect(Object.keys(core).sort()).toEqual(['createApi'])
    expect(Object.keys(react).sort()).toEqual([
      'WyStackProvider',
      'createReactBindings',
      'useAction',
      'useMutation',
      'useQuery',
      'useWyStackClient',
    ])
    expect(Object.keys(web).sort()).toEqual([
      'createClient',
      'createWebSocketPipe',
      'createWsManager',
      'createWyStack',
    ])
    expect(Object.keys(electron).sort()).toEqual(['createElectronPipe', 'createIpcManager'])
  })
})
