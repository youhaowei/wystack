declare function reject(value: object): void
declare function rejectUnion(value: object | null): void
declare function accept<T extends object>(value: T): void
declare class Envelope {
  handle(value: object): void
}

void reject
void rejectUnion
void accept
void Envelope
