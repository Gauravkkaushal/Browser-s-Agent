import type { PrivacyMode } from '../../shared/types/netrashield'

export const privacyModes: Array<{ id: PrivacyMode; title: string }> = [
  { id: 'strict', title: 'Strict' },
  { id: 'balanced', title: 'Balanced' },
  { id: 'fast', title: 'Fast' },
]
