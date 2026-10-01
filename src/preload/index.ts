import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { PUSH_CHANNELS } from '../shared/types'
import type { DeskApi } from '../shared/api'

/**
 * Единственный канал связи renderer с main. Никаких Node-API и секретов в renderer:
 * API-ключ, например, живёт только в main и наружу отдаётся лишь флагом «настроен».
 *
 * Аннотация `: DeskApi` — не украшение: она заставляет компилятор проверить, что
 * реализация не разошлась с интерфейсом, на который опирается renderer.
 */
const api: DeskApi = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    forgetProject: (dir) => ipcRenderer.invoke('settings:forget-project', dir)
  },

  project: {
    pick: () => ipcRenderer.invoke('project:pick'),
    overview: () => ipcRenderer.invoke('project:overview'),
    changes: () => ipcRenderer.invoke('project:changes'),
    diff: (path) => ipcRenderer.invoke('project:diff', path)
  },

  session: {
    start: (dir) => ipcRenderer.invoke('session:start', dir),
    resume: (id) => ipcRenderer.invoke('session:resume', id),
    info: () => ipcRenderer.invoke('session:info'),
    stop: () => ipcRenderer.invoke('session:stop'),
    openTerminal: () => ipcRenderer.invoke('session:open-terminal'),
    attachCommand: () => ipcRenderer.invoke('session:attach-command'),
    submit: (text) => ipcRenderer.invoke('session:submit', text),
    answerPermission: (allow) => ipcRenderer.invoke('session:answer-permission', allow),
    interrupt: () => ipcRenderer.invoke('session:interrupt')
  },

  history: {
    list: () => ipcRenderer.invoke('history:list')
  },

  claude: {
    probe: () => ipcRenderer.invoke('claude:probe')
  },

  stt: {
    probe: (locale) => ipcRenderer.invoke('stt:probe', locale),
    // ArrayBuffer переживает structured clone, поэтому аудио идёт без base64.
    transcribe: (wav, locale) => ipcRenderer.invoke('stt:transcribe', wav, locale)
  },

  speech: {
    stop: () => ipcRenderer.invoke('speech:stop'),
    voices: () => ipcRenderer.invoke('speech:voices'),
    preview: () => ipcRenderer.invoke('speech:preview'),
    ended: (id) => ipcRenderer.invoke('speech:ended', id)
  },

  secrets: {
    status: () => ipcRenderer.invoke('secrets:status'),
    setKey: (value) => ipcRenderer.invoke('secrets:set-key', value),
    clearKey: () => ipcRenderer.invoke('secrets:clear-key')
  },

  telegram: {
    status: () => ipcRenderer.invoke('telegram:status'),
    setToken: (value) => ipcRenderer.invoke('telegram:set-token', value),
    clearToken: () => ipcRenderer.invoke('telegram:clear-token'),
    setEnabled: (enabled) => ipcRenderer.invoke('telegram:set-enabled', enabled),
    pair: () => ipcRenderer.invoke('telegram:pair'),
    unbind: () => ipcRenderer.invoke('telegram:unbind')
  },

  on: {
    transcriptEvent(cb) {
      const handler = (_e: IpcRendererEvent, payload: Parameters<typeof cb>[0]): void => cb(payload)
      ipcRenderer.on(PUSH_CHANNELS.transcriptEvent, handler)
      return () => ipcRenderer.off(PUSH_CHANNELS.transcriptEvent, handler)
    },
    sessionUpdate(cb) {
      const handler = (_e: IpcRendererEvent, payload: Parameters<typeof cb>[0]): void => cb(payload)
      ipcRenderer.on(PUSH_CHANNELS.sessionUpdate, handler)
      return () => ipcRenderer.off(PUSH_CHANNELS.sessionUpdate, handler)
    },
    speaking(cb) {
      const handler = (_e: IpcRendererEvent, speaking: boolean): void => cb(speaking)
      ipcRenderer.on(PUSH_CHANNELS.speaking, handler)
      return () => ipcRenderer.off(PUSH_CHANNELS.speaking, handler)
    },
    speechPlay(cb) {
      const handler = (_e: IpcRendererEvent, payload: Parameters<typeof cb>[0]): void => cb(payload)
      ipcRenderer.on(PUSH_CHANNELS.speechPlay, handler)
      return () => ipcRenderer.off(PUSH_CHANNELS.speechPlay, handler)
    },
    speechCancel(cb) {
      const handler = (_e: IpcRendererEvent, id: number): void => cb(id)
      ipcRenderer.on(PUSH_CHANNELS.speechCancel, handler)
      return () => ipcRenderer.off(PUSH_CHANNELS.speechCancel, handler)
    },
    appError(cb) {
      const handler = (_e: IpcRendererEvent, payload: Parameters<typeof cb>[0]): void => cb(payload)
      ipcRenderer.on(PUSH_CHANNELS.appError, handler)
      return () => ipcRenderer.off(PUSH_CHANNELS.appError, handler)
    }
  }
}

contextBridge.exposeInMainWorld('desk', api)
