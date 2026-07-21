export interface Permission<in TContext> {
  readonly id: string
  readonly description: string
  check(ctx: TContext): boolean | Promise<boolean>
}
