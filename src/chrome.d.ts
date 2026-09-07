/**
 * Minimal ambient declarations for the subset of the Chrome extension API the
 * popup launcher touches. Kept local so the project does not need
 * @types/chrome just for a status panel.
 */
declare namespace chrome {
  namespace runtime {
    const lastError: { message?: string } | undefined
    function sendMessage(message: unknown, callback?: (response?: any) => void): void
    function getManifest(): { version: string; [key: string]: unknown }
    function getURL(path: string): string
  }
  namespace tabs {
    function create(properties: { url: string; active?: boolean }): void
  }
  namespace windows {
    function create(
      properties: {
        url: string
        type?: string
        width?: number
        height?: number
        left?: number
        top?: number
      },
      callback?: (created?: unknown) => void,
    ): void
  }
  namespace storage {
    const local: {
      get(keys: string | string[] | null, callback: (items: Record<string, any>) => void): void
      set(items: Record<string, unknown>, callback?: () => void): void
    }
  }
}
