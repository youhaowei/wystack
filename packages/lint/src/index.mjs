const isIdentifier = (node) => node?.type === 'Identifier'

const unwrapParameter = (parameter) => {
  if (parameter.type === 'TSParameterProperty') {
    return unwrapParameter(parameter.parameter)
  }

  if (parameter.type === 'AssignmentPattern') {
    return unwrapParameter(parameter.left)
  }

  return parameter
}

const annotationType = (node) => node?.typeAnnotation?.typeAnnotation

const isStaticValue = (node) =>
  node?.type === 'Literal' ||
  node?.type === 'TemplateLiteral' ||
  node?.type === 'ObjectExpression' ||
  node?.type === 'ArrayExpression'

const isPrimitiveAnnotation = (node) =>
  node?.type === 'TSStringKeyword' ||
  node?.type === 'TSNumberKeyword' ||
  node?.type === 'TSBooleanKeyword'

const isArrayAnnotation = (node) => node?.type === 'TSArrayType'

const isRecordAnnotation = (node) =>
  node?.type === 'TSTypeReference' && node.typeName?.name === 'Record'

const functionParent = (node) => {
  let current = node.parent

  while (
    current &&
    current.type !== 'FunctionExpression' &&
    current.type !== 'ArrowFunctionExpression'
  ) {
    current = current.parent
  }

  return current
}

const isProxyGetTrap = (node) => {
  const property = node.parent
  if (property?.type !== 'Property' || property.key?.name !== 'get') {
    return false
  }

  const handler = property.parent
  if (handler?.type !== 'ObjectExpression') {
    return false
  }

  const proxy = handler.parent
  return (
    proxy?.type === 'NewExpression' &&
    proxy.callee?.type === 'Identifier' &&
    proxy.callee.name === 'Proxy' &&
    proxy.arguments?.[1] === handler
  )
}

const isImportedBinding = (context, identifier, imports) => {
  let scope = context.sourceCode.getScope(identifier)

  while (scope) {
    const variable = scope.variables?.find((candidate) => candidate.name === identifier.name)
    if (variable) {
      return variable.identifiers?.some((definition) => imports.has(definition))
    }

    scope = scope.upper
  }

  return false
}

const isCanonicalProxyForward = (node) => {
  const trap = functionParent(node)
  if (!trap || !isProxyGetTrap(trap) || trap.params.length < 3) {
    return false
  }

  const parameterNames = trap.params
    .slice(0, 3)
    .map(unwrapParameter)
    .map((parameter) => (isIdentifier(parameter) ? parameter.name : undefined))

  if (parameterNames.some((name) => name === undefined) || node.arguments.length !== 3) {
    return false
  }

  return node.arguments.every(
    (argument, index) => isIdentifier(argument) && argument.name === parameterNames[index],
  )
}

const noObjectParameters = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow the broad object type in function parameters; use a meaningful shape or a generic object constraint.',
    },
    messages: {
      useConstraint:
        'Replace this broad object parameter with a meaningful shape or a generic constraint such as <T extends object>.',
    },
  },
  create(context) {
    const checkParameters = (node) => {
      for (const parameter of node.params ?? []) {
        const value = unwrapParameter(parameter)
        const annotation = annotationType(value)
        if (annotation?.type === 'TSObjectKeyword') {
          context.report({ node: annotation, messageId: 'useConstraint' })
        }
      }
    }

    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSDeclareFunction: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    }
  },
}

const noChainedTypeAssertions = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow chained TypeScript assertions, which can bypass incompatible types without runtime validation.',
    },
    messages: {
      noChain:
        'Avoid chained type assertions. Validate the value or introduce a type-safe conversion instead.',
    },
  },
  create(context) {
    return {
      TSAsExpression(node) {
        if (
          node.expression?.type === 'TSAsExpression' ||
          node.expression?.type === 'TSTypeAssertion'
        ) {
          context.report({ node, messageId: 'noChain' })
        }
      },
      TSTypeAssertion(node) {
        if (
          node.expression?.type === 'TSAsExpression' ||
          node.expression?.type === 'TSTypeAssertion'
        ) {
          context.report({ node, messageId: 'noChain' })
        }
      },
    }
  },
}

const noKnownValueWidening = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Keep known constant values precise when a primitive, array, or Record annotation would discard useful literal or key information.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          targets: {
            type: 'array',
            items: {
              enum: ['primitive', 'array', 'record'],
            },
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      preserveKnownValue:
        'This const initializer has more precise information than its annotation. Infer it or use satisfies when validating a structural contract.',
    },
  },
  create(context) {
    const targets = new Set(context.options[0]?.targets ?? ['primitive', 'array', 'record'])

    return {
      VariableDeclarator(node) {
        const declaration = node.parent
        if (
          declaration?.type !== 'VariableDeclaration' ||
          declaration.kind !== 'const' ||
          !isStaticValue(node.init)
        ) {
          return
        }

        const annotation = annotationType(node.id)
        if (!annotation) {
          return
        }

        const hasTarget =
          (targets.has('primitive') &&
            (node.init.type === 'Literal' || node.init.type === 'TemplateLiteral') &&
            isPrimitiveAnnotation(annotation)) ||
          (targets.has('array') &&
            node.init.type === 'ArrayExpression' &&
            isArrayAnnotation(annotation)) ||
          (targets.has('record') &&
            node.init.type === 'ObjectExpression' &&
            isRecordAnnotation(annotation))

        if (hasTarget) {
          context.report({ node: annotation, messageId: 'preserveKnownValue' })
        }
      },
    }
  },
}

const noReflectGet = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow Reflect.get except for canonical receiver-preserving forwarding in a Proxy get trap.',
    },
    messages: {
      useTypedAccess:
        'Avoid Reflect.get. Use typed property access, or a canonical receiver-preserving Proxy get forwarder.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee
        const isReflectGet =
          callee?.type === 'MemberExpression' &&
          callee.object?.type === 'Identifier' &&
          callee.object.name === 'Reflect' &&
          ((callee.computed === false && callee.property?.name === 'get') ||
            (callee.computed === true && callee.property?.value === 'get'))

        if (isReflectGet && !isCanonicalProxyForward(node)) {
          context.report({ node, messageId: 'useTypedAccess' })
        }
      },
    }
  },
}

const noModuleMocksInDomainTests = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow module replacement in domain tests, where real dependency seams give stronger behavioral evidence.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          testModules: {
            type: 'array',
            items: { type: 'string' },
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      noModuleMock:
        'Avoid module mocks in domain tests. Exercise a real dependency seam or use an explicit test double instead.',
    },
  },
  create(context) {
    const testModules = new Set(context.options[0]?.testModules ?? ['vitest', 'vite-plus/test'])
    const mockBindings = new Set()
    const testNamespaces = new Set()
    const candidates = []

    return {
      ImportDeclaration(node) {
        if (!testModules.has(node.source?.value)) {
          return
        }

        for (const specifier of node.specifiers ?? []) {
          if (
            specifier.type === 'ImportSpecifier' &&
            specifier.imported?.name === 'vi' &&
            isIdentifier(specifier.local)
          ) {
            mockBindings.add(specifier.local)
          }

          if (specifier.type === 'ImportNamespaceSpecifier' && isIdentifier(specifier.local)) {
            testNamespaces.add(specifier.local)
          }
        }
      },
      CallExpression(node) {
        const callee = node.callee
        if (callee?.type !== 'MemberExpression') {
          return
        }

        const method = callee.computed ? callee.property?.value : callee.property?.name
        if (method === 'mock' || method === 'doMock') {
          candidates.push(node)
        }
      },
      'Program:exit'() {
        for (const node of candidates) {
          const callee = node.callee
          const isDirectMock =
            isIdentifier(callee.object) && isImportedBinding(context, callee.object, mockBindings)
          const isNamespaceMock =
            callee.object?.type === 'MemberExpression' &&
            isIdentifier(callee.object.object) &&
            isImportedBinding(context, callee.object.object, testNamespaces) &&
            ((callee.object.computed === false && callee.object.property?.name === 'vi') ||
              (callee.object.computed === true && callee.object.property?.value === 'vi'))

          if (isDirectMock || isNamespaceMock) {
            context.report({ node, messageId: 'noModuleMock' })
          }
        }
      },
    }
  },
}

const noPlaceholderSymbolNames = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow configured placeholder names in declarations; match exact names so domain vocabulary remains available.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            uniqueItems: true,
          },
        },
        required: ['names'],
        additionalProperties: false,
      },
    ],
    messages: {
      useDomainName: 'Replace this placeholder symbol name with a domain-specific name.',
    },
  },
  create(context) {
    const names = new Set(context.options[0]?.names ?? [])

    const check = (node) => {
      if (names.has(node.name)) {
        context.report({ node, messageId: 'useDomainName' })
      }
    }

    return {
      VariableDeclarator(node) {
        if (isIdentifier(node.id)) {
          check(node.id)
        }
      },
      FunctionDeclaration(node) {
        if (isIdentifier(node.id)) {
          check(node.id)
        }
      },
      ClassDeclaration(node) {
        if (isIdentifier(node.id)) {
          check(node.id)
        }
      },
      TSTypeAliasDeclaration(node) {
        if (isIdentifier(node.id)) {
          check(node.id)
        }
      },
      TSInterfaceDeclaration(node) {
        if (isIdentifier(node.id)) {
          check(node.id)
        }
      },
    }
  },
}

export default {
  meta: {
    name: 'wystack',
  },
  rules: {
    'no-object-parameters': noObjectParameters,
    'no-chained-type-assertions': noChainedTypeAssertions,
    'no-known-value-widening': noKnownValueWidening,
    'no-reflect-get': noReflectGet,
    'no-module-mocks-in-domain-tests': noModuleMocksInDomainTests,
    'no-placeholder-symbol-names': noPlaceholderSymbolNames,
  },
}
