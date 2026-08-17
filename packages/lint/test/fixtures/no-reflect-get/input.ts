const target = { value: 1 }
const property = 'value'
const receiver = target

Reflect.get(target, property, receiver)

const forwarded = new Proxy(target, {
  get(target, property, receiver) {
    return Reflect.get(target, property, receiver)
  },
})

const wrongReceiver = new Proxy(target, {
  get(target, property, receiver) {
    return Reflect.get(target, property, target)
  },
})

const targetGetMethod = new Proxy(
  {
    get(target, property, receiver) {
      return Reflect.get(target, property, receiver)
    },
  },
  {},
)

const nestedFunction = new Proxy(target, {
  get(target, property, receiver) {
    function reflectFromDifferentScope(target: object, property: string, receiver: object) {
      return Reflect.get(target, property, receiver)
    }

    return reflectFromDifferentScope(target, property, receiver)
  },
})

const shadowedParameter = new Proxy(target, {
  get(target, property, receiver) {
    {
      const target = {}
      return Reflect.get(target, property, receiver)
    }
  },
})

const ignoredForward = new Proxy(target, {
  get(target, property, receiver) {
    Reflect.get(target, property, receiver)
    return target[property]
  },
})

{
  const Reflect = { get: () => undefined }
  Reflect.get(target, property, receiver)
}

{
  const Proxy = class {
    constructor(..._arguments: unknown[]) {}
  }

  const shadowedProxy = new Proxy(target, {
    get(target, property, receiver) {
      return Reflect.get(target, property, receiver)
    },
  })

  void shadowedProxy
}

void forwarded
void wrongReceiver
void targetGetMethod
void nestedFunction
void shadowedParameter
void ignoredForward
