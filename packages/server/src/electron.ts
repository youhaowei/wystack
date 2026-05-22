import type {
  ClientTransportMessage,
  TransportEndpoint,
  TransportMessage,
  TransportMessageHandler,
} from './transport'

type IpcMainLike = {
  handle(
    channel: string,
    listener: (event: unknown, message: ClientTransportMessage) => void | Promise<void>,
  ): void
  removeHandler(channel: string): void
}

type BrowserWindowLike = {
  webContents: {
    send(channel: string, message: TransportMessage): void
  }
}

type BrowserWindowModuleLike = {
  getAllWindows(): BrowserWindowLike[]
}

export type ElectronTransportOptions = {
  ipcMain: IpcMainLike
  BrowserWindow: BrowserWindowModuleLike
  sendChannel: string
  receiveChannel: string
}

export function createElectronTransportEndpoint(options: ElectronTransportOptions): TransportEndpoint {
  const handlers = new Set<TransportMessageHandler>()

  options.ipcMain.handle(options.sendChannel, (_event, message) => {
    for (const handler of handlers) {
      handler(message)
    }
  })

  return {
    send(message: TransportMessage) {
      for (const win of options.BrowserWindow.getAllWindows()) {
        win.webContents.send(options.receiveChannel, message)
      }
    },
    onMessage(handler: TransportMessageHandler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    close() {
      handlers.clear()
      options.ipcMain.removeHandler(options.sendChannel)
    },
  }
}
