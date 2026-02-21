export const TEST_TYPES = ['Bloods', 'CAT', 'MRI', 'Physio'] as const

export type TestType = (typeof TEST_TYPES)[number]

export type TestChecklist = Record<TestType, boolean>

export interface PatientCardData {
  id: string
  name: string
  tests: TestChecklist
}
