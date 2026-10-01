/// <reference types="vite/client" />
import type { DeskApi } from '../shared/api'

declare global {
  interface Window {
    desk: DeskApi
  }
}
