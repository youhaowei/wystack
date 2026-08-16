declare const source: string

const widenedPrimitive: string = 'known'
const widenedTemplate: string = `known`
const widenedRecord: Record<string, string> = { primary: 'blue' }
const inferredPrimitive = 'known'
const checkedRecord = { primary: 'blue' } satisfies Record<string, string>
const publicBoundary: string = source

void widenedPrimitive
void widenedRecord
void inferredPrimitive
void checkedRecord
void publicBoundary
