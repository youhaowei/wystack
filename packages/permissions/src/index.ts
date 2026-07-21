// @wystack/permissions
// Runtime-neutral permission definitions and fail-closed evaluation.

export { type Permission } from './permission'
export { definePermissions } from './define-permissions'
export { allOf, anyOf } from './combinators'
export { evaluate, assertPermission, PermissionDeniedError } from './evaluate'
