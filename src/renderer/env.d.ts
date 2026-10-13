import type { PalmierApi } from '../shared/api'

declare global {
  interface Window {
    palmier: PalmierApi
    palmierFiles: { pathForFile(file: File): string }
  }
}

export {}
