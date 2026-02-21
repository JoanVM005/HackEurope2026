import type { PatientCardData } from './types'

export const mockPatients: PatientCardData[] = [
  {
    id: 'pat-001',
    name: 'Aaliyah Bennett',
    tests: {
      Bloods: true,
      CAT: false,
      MRI: true,
      Physio: false,
    },
  },
  {
    id: 'pat-002',
    name: 'Owen Fletcher',
    tests: {
      Bloods: true,
      CAT: true,
      MRI: false,
      Physio: false,
    },
  },
  {
    id: 'pat-003',
    name: 'Maya Khoury',
    tests: {
      Bloods: false,
      CAT: false,
      MRI: true,
      Physio: true,
    },
  },
  {
    id: 'pat-004',
    name: 'Luca Stein',
    tests: {
      Bloods: true,
      CAT: false,
      MRI: false,
      Physio: true,
    },
  },
]
