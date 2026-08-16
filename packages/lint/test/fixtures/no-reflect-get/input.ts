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

void forwarded
void wrongReceiver
