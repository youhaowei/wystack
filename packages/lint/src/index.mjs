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

const hasStaticObjectKeys = (node) =>
  node?.type === 'ObjectExpression' &&
  node.properties.every((property) => property.type === 'Property' && !property.computed)

const isStaticValue = (node) =>
  node?.type === 'Literal' ||
  (node?.type === 'TemplateLiteral' && node.expressions.length === 0) ||
  hasStaticObjectKeys(node)

const isPrimitiveAnnotation = (node) =>
  node?.type === 'TSStringKeyword' ||
  node?.type === 'TSNumberKeyword' ||
  node?.type === 'TSBooleanKeyword'

const isRecordAnnotation = (node, context) => {
  if (
    node?.type !== 'TSTypeReference' ||
    node.typeName?.name !== 'Record' ||
    !isUnshadowedGlobal(context, node.typeName)
  ) {
    return false
  }

  const keyType = (node.typeArguments?.params ?? node.typeParameters?.params ?? [])[0]
  const isOpenKeyType = (type, aliases = new Set()) => {
    if (
      type?.type === 'TSStringKeyword' ||
      type?.type === 'TSNumberKeyword' ||
      type?.type === 'TSSymbolKeyword'
    ) {
      return true
    }

    if (type?.type === 'TSUnionType') {
      return type.types.some((member) => isOpenKeyType(member, aliases))
    }

    if (type?.type !== 'TSTypeReference' || type.typeName?.type !== 'Identifier') {
      return false
    }

    if (type.typeName.name === 'PropertyKey' && isUnshadowedGlobal(context, type.typeName)) {
      return true
    }

    const variable = findVariable(context, type.typeName)
    const declaration = variable?.defs?.find(
      (definition) => definition.node?.type === 'TSTypeAliasDeclaration',
    )?.node

    if (!declaration || declaration.typeParameters || aliases.has(variable)) {
      return false
    }

    aliases.add(variable)
    return isOpenKeyType(declaration.typeAnnotation, aliases)
  }

  return isOpenKeyType(keyType)
}

const functionParent = (node) => {
  let current = node.parent

  while (
    current &&
    !current.type.endsWith('FunctionExpression') &&
    current.type !== 'FunctionDeclaration'
  ) {
    current = current.parent
  }

  return current
}

const findVariable = (context, identifier) => {
  let scope = context.sourceCode.getScope(identifier)

  while (scope) {
    const variable = scope.variables?.find((candidate) => candidate.name === identifier.name)
    if (variable) {
      return variable
    }

    scope = scope.upper
  }

  return undefined
}

const isUnshadowedGlobal = (context, identifier) => {
  const variable = findVariable(context, identifier)
  return !variable || (variable.defs?.length ?? 0) === 0
}

const isProxyGetTrap = (node, context) => {
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
    isUnshadowedGlobal(context, proxy.callee) &&
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

const isCanonicalProxyForward = (node, context) => {
  const trap = functionParent(node)
  if (!trap || !isProxyGetTrap(trap, context) || trap.params.length < 3) {
    return false
  }

  const parameters = trap.params.slice(0, 3).map(unwrapParameter).filter(isIdentifier)

  if (
    parameters.length !== 3 ||
    node.arguments.length !== 3 ||
    node.parent?.type !== 'ReturnStatement'
  ) {
    return false
  }

  return node.arguments.every(
    (argument, index) =>
      isIdentifier(argument) &&
      findVariable(context, argument) === findVariable(context, parameters[index]),
  )
}

const hasBroadObjectType = (node) => {
  if (node?.type === 'TSObjectKeyword') {
    return true
  }

  if (node?.type === 'TSUnionType' || node?.type === 'TSIntersectionType') {
    return node.types.some(hasBroadObjectType)
  }

  return false
}

const unwrapAssertionExpression = (node) => {
  let expression = node

  while (expression?.type === 'TSNonNullExpression') {
    expression = expression.expression
  }

  return expression
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
        if (hasBroadObjectType(annotation)) {
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
      TSEmptyBodyFunctionExpression: checkParameters,
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
          unwrapAssertionExpression(node.expression)?.type === 'TSAsExpression' ||
          unwrapAssertionExpression(node.expression)?.type === 'TSTypeAssertion'
        ) {
          context.report({ node, messageId: 'noChain' })
        }
      },
      TSTypeAssertion(node) {
        if (
          unwrapAssertionExpression(node.expression)?.type === 'TSAsExpression' ||
          unwrapAssertionExpression(node.expression)?.type === 'TSTypeAssertion'
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
        'Keep known constant values precise when a primitive or Record annotation would discard useful literal or key information.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          targets: {
            type: 'array',
            items: {
              enum: ['primitive', 'record'],
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
    const targets = new Set(context.options[0]?.targets ?? ['primitive', 'record'])

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
          (targets.has('record') &&
            node.init.type === 'ObjectExpression' &&
            isRecordAnnotation(annotation, context))

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

        if (
          isReflectGet &&
          isUnshadowedGlobal(context, callee.object) &&
          !isCanonicalProxyForward(node, context)
        ) {
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
          globalBindings: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
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
    const globalBindings = new Set(context.options[0]?.globalBindings ?? [])
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
            isIdentifier(callee.object) &&
            (isImportedBinding(context, callee.object, mockBindings) ||
              (globalBindings.has(callee.object.name) &&
                isUnshadowedGlobal(context, callee.object)))
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
        'Disallow configured placeholder names in declarations and named type or class members; match exact names so domain vocabulary remains available.',
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

    const checkBinding = (node) => {
      if (isIdentifier(node)) {
        check(node)
        return
      }

      if (node?.type === 'AssignmentPattern') {
        checkBinding(node.left)
        return
      }

      if (node?.type === 'RestElement' || node?.type === 'TSParameterProperty') {
        checkBinding(node.argument ?? node.parameter)
        return
      }

      if (node?.type === 'ArrayPattern') {
        for (const element of node.elements ?? []) {
          checkBinding(element)
        }
        return
      }

      if (node?.type === 'ObjectPattern') {
        for (const property of node.properties ?? []) {
          checkBinding(property.value ?? property.argument)
        }
      }
    }

    const checkParameters = (node) => {
      for (const parameter of node.params ?? []) {
        checkBinding(parameter)
      }
    }

    const checkNamedFunction = (node) => {
      if (isIdentifier(node.id)) {
        check(node.id)
      }

      checkParameters(node)
    }

    const checkNamedKey = (node) => {
      if (node.parent?.type !== 'ObjectPattern' && !node.computed && isIdentifier(node.key)) {
        check(node.key)
      }
    }

    const checkEnumMember = (node) => {
      if (isIdentifier(node.id)) {
        check(node.id)
      }
    }

    const checkTypeParameter = (node) => {
      if (isIdentifier(node.name)) {
        check(node.name)
      }
    }

    return {
      VariableDeclarator(node) {
        checkBinding(node.id)
      },
      FunctionDeclaration: checkNamedFunction,
      FunctionExpression: checkNamedFunction,
      ArrowFunctionExpression: checkParameters,
      TSDeclareFunction: checkNamedFunction,
      TSFunctionType: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      CatchClause(node) {
        checkBinding(node.param)
      },
      ClassDeclaration(node) {
        if (isIdentifier(node.id)) {
          check(node.id)
        }
      },
      ClassExpression(node) {
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
      TSEnumDeclaration(node) {
        if (isIdentifier(node.id)) {
          check(node.id)
        }
      },
      TSModuleDeclaration(node) {
        if (isIdentifier(node.id)) {
          check(node.id)
        }
      },
      ImportSpecifier(node) {
        checkBinding(node.local)
      },
      ImportDefaultSpecifier(node) {
        checkBinding(node.local)
      },
      ImportNamespaceSpecifier(node) {
        checkBinding(node.local)
      },
      TSEnumMember: checkEnumMember,
      TSTypeParameter: checkTypeParameter,
      MethodDefinition: checkNamedKey,
      PropertyDefinition: checkNamedKey,
      TSPropertySignature: checkNamedKey,
      TSMethodSignature(node) {
        checkNamedKey(node)
        checkParameters(node)
      },
      TSIndexSignature: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
    }
  },
}

const noUnmanagedPglite = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require test-created PGlite instances to use the shared lifecycle-managed factory.',
    },
    messages: {
      useTestFactory:
        'Use createTestPg from @wystack/db/testing so the PGlite instance is disposed after the test file finishes.',
      useTestDb:
        'Use createTestDb from @wystack/db/testing so an underlying PGlite instance is disposed after the test file finishes.',
      registerLifecycle:
        'Call useTestPglite() at module scope. The harness does not drain a file that has not registered its lifecycle hooks.',
      noSharedLifecycleRegistration:
        'Do not call useTestPglite() at module scope in a shared module. Expose a use...() function that each importing test file calls instead; a shared module registers only for its first importer.',
    },
  },
  create(context) {
    const pgliteImports = new Set()
    const pgliteNamespaceImports = new Set()
    const createDbImports = new Set()
    const testFactoryImports = new Set()
    const lifecycleImports = new Set()
    const testFactoryImportNodes = []
    const moduleLifecycleRegistrations = []
    let hasLifecycleRegistration = false
    let isTestFile = false
    const isPgliteSource = (source) =>
      source === '@electric-sql/pglite' || source?.startsWith('@electric-sql/pglite/')
    const isRelativeSource = (source) => source?.startsWith('./') || source?.startsWith('../')

    return {
      ImportDeclaration(node) {
        const source = node.source?.value

        for (const specifier of node.specifiers ?? []) {
          if (
            node.source?.value === 'bun:test' &&
            specifier.type === 'ImportSpecifier' &&
            (specifier.imported?.name === 'test' ||
              specifier.imported?.name === 'it' ||
              specifier.imported?.name === 'describe')
          ) {
            isTestFile = true
          }

          if (
            isPgliteSource(source) &&
            specifier.type === 'ImportSpecifier' &&
            specifier.imported?.name === 'PGlite' &&
            isIdentifier(specifier.local)
          ) {
            pgliteImports.add(specifier.local)
          }

          if (
            isPgliteSource(source) &&
            specifier.type === 'ImportNamespaceSpecifier' &&
            isIdentifier(specifier.local)
          ) {
            pgliteNamespaceImports.add(specifier.local)
          }

          if (
            (source === '@wystack/db' || isRelativeSource(source)) &&
            specifier.type === 'ImportSpecifier' &&
            specifier.imported?.name === 'createDb' &&
            isIdentifier(specifier.local)
          ) {
            createDbImports.add(specifier.local)
          }

          if (
            node.source?.value === '@wystack/db/testing' &&
            specifier.type === 'ImportSpecifier' &&
            (specifier.imported?.name === 'createTestPg' ||
              specifier.imported?.name === 'createTestDb') &&
            isIdentifier(specifier.local)
          ) {
            testFactoryImports.add(specifier.local)
            testFactoryImportNodes.push(specifier.local)
          }

          if (
            node.source?.value === '@wystack/db/testing' &&
            specifier.type === 'ImportSpecifier' &&
            specifier.imported?.name === 'useTestPglite' &&
            isIdentifier(specifier.local)
          ) {
            lifecycleImports.add(specifier.local)
          }
        }
      },
      ImportExpression(node) {
        if (isPgliteSource(node.source?.value)) {
          context.report({ node, messageId: 'useTestFactory' })
        }
      },
      NewExpression(node) {
        const callee = node.callee
        const namespaceConstructor =
          callee?.type === 'MemberExpression' &&
          isIdentifier(callee.object) &&
          (callee.computed ? callee.property?.value : callee.property?.name) === 'PGlite' &&
          isImportedBinding(context, callee.object, pgliteNamespaceImports)

        if (
          (isIdentifier(callee) && isImportedBinding(context, callee, pgliteImports)) ||
          namespaceConstructor
        ) {
          context.report({ node, messageId: 'useTestFactory' })
        }
      },
      CallExpression(node) {
        if (
          node.parent?.type === 'ExpressionStatement' &&
          node.parent.parent?.type === 'Program' &&
          isIdentifier(node.callee) &&
          isImportedBinding(context, node.callee, lifecycleImports)
        ) {
          hasLifecycleRegistration = true
          moduleLifecycleRegistrations.push(node)
        }

        if (isIdentifier(node.callee) && isImportedBinding(context, node.callee, createDbImports)) {
          context.report({ node, messageId: 'useTestDb' })
        }
      },
      'Program:exit'() {
        if (isTestFile && testFactoryImports.size > 0 && !hasLifecycleRegistration) {
          context.report({ node: testFactoryImportNodes[0], messageId: 'registerLifecycle' })
        }

        if (!isTestFile) {
          for (const node of moduleLifecycleRegistrations) {
            context.report({ node, messageId: 'noSharedLifecycleRegistration' })
          }
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
    'no-unmanaged-pglite': noUnmanagedPglite,
  },
}
