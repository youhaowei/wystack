declare const isoBrand: unique symbol

export type ISOTimestamp = string & { readonly [isoBrand]: true }

export function isoNow(): ISOTimestamp {
  return new Date().toISOString() as ISOTimestamp
}

export function isoFrom(input: string | Date): ISOTimestamp {
  const d = input instanceof Date ? input : new Date(input)
  if (isNaN(d.getTime())) {
    throw new TypeError(`Invalid date: "${input}"`)
  }
  return d.toISOString() as ISOTimestamp
}

export function isISOTimestamp(input: string): input is ISOTimestamp {
  const d = new Date(input)
  return !isNaN(d.getTime()) && d.toISOString() === input
}
