export const ORG_ROLES = ["owner", "admin", "member"] as const

export type OrgRole = (typeof ORG_ROLES)[number]

export function isOrgRole(value: string): value is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(value)
}
