declare const source: string
declare const palette: Record<string, string>
declare const runtimeKey: string

const widenedPrimitive: string = 'known'
const widenedTemplate: string = `known`
const widenedRecord: Record<string, string> = { primary: 'blue' }
const finiteRecord: Record<'primary', string> = { primary: 'blue' }
const dynamicTemplate: string = `${source}`
const copiedRecord: Record<string, string> = { ...palette }
const computedRecord: Record<string, string> = { [runtimeKey]: source }
const inferredPrimitive = 'known'
const checkedRecord = { primary: 'blue' } satisfies Record<string, string>
const publicBoundary: string = source

void widenedPrimitive
void widenedRecord
void finiteRecord
void dynamicTemplate
void copiedRecord
void computedRecord
void inferredPrimitive
void checkedRecord
void publicBoundary
