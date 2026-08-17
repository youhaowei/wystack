declare const source: string
declare const palette: Record<string, string>
declare const runtimeKey: string

const widenedPrimitive: string = 'known'
const widenedTemplate: string = `known`
const widenedRecord: Record<string, string> = { primary: 'blue' }
const widenedUnionRecord: Record<string | number, string> = { primary: 'blue' }
const widenedPropertyKeyRecord: Record<PropertyKey, string> = { primary: 'blue' }
const widenedLiteralUnionRecord: Record<string | 'primary', string> = { primary: 'blue' }
const widenedPropertyKeyUnionRecord: Record<PropertyKey | 'primary', string> = {
  primary: 'blue',
}
const finiteRecord: Record<'primary', string> = { primary: 'blue' }

namespace finitePropertyKey {
  type PropertyKey = 'primary'
  const shadowedPropertyKeyRecord: Record<PropertyKey, string> = { primary: 'blue' }

  void shadowedPropertyKeyRecord
}

namespace shadowedRecord {
  type Record<Key, Value> = Value
  const shadowedRecordAnnotation: Record<string, string> = 'blue'

  void shadowedRecordAnnotation
}
const dynamicTemplate: string = `${source}`
const copiedRecord: Record<string, string> = { ...palette }
const computedRecord: Record<string, string> = { [runtimeKey]: source }
const inferredPrimitive = 'known'
const checkedRecord = { primary: 'blue' } satisfies Record<string, string>
const publicBoundary: string = source

void widenedPrimitive
void widenedRecord
void widenedUnionRecord
void widenedPropertyKeyRecord
void widenedLiteralUnionRecord
void widenedPropertyKeyUnionRecord
void finiteRecord
void dynamicTemplate
void copiedRecord
void computedRecord
void inferredPrimitive
void checkedRecord
void publicBoundary
