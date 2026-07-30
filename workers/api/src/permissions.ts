import type { AuthUser } from './auth'

export interface PermissionEnvironment {
  PYRO_ENVIRONMENT?: string
  PYRO_PUBLISHER_IDS?: string
}

export interface UserPermissions {
  canPublish: boolean
}

export function canPublish(env: PermissionEnvironment, user: AuthUser): boolean {
  if (env.PYRO_ENVIRONMENT !== 'production' && user.id === 'dev-anonymous') return true
  const configured = (env.PYRO_PUBLISHER_IDS || '').split(',').map((value) => value.trim()).filter(Boolean)
  return configured.includes(user.id) || configured.includes(user.openId)
}

export function permissionsFor(env: PermissionEnvironment, user: AuthUser): UserPermissions {
  return { canPublish: canPublish(env, user) }
}
