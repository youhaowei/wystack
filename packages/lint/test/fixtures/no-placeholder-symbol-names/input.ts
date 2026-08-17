const shape = { id: 'unhelpful' }
const dashboardShape = { id: 'domain-vocabulary-is-allowed' }

const namedExpression = function shape() {}
function withShapeParameter(shape: string) {
  return shape
}

try {
  throw new Error('fixture')
} catch (shape) {
  void shape
}

class Example {
  shape() {}
}

const objectWithPlaceholder = { shape: true }

interface PlaceholderContract<shape> {
  [shape: string]: string
  (shape: string): void
  shape: string
}

enum PlaceholderEnum {
  shape,
}

{
  const { shape: destructuredShape } = { shape: 'domain-vocabulary-is-allowed' }
  const { shape } = { shape: 'unhelpful' }

  void destructuredShape
  void shape
}

void shape
void dashboardShape
void namedExpression
void withShapeParameter
void Example
void objectWithPlaceholder
