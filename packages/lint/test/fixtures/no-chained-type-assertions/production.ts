declare const input: unknown
const value = input as unknown as { id: string }
const alternate = (<unknown>input) as { id: string }
const nonNull = (input as unknown)! as { id: string }

void value
void alternate
void nonNull
