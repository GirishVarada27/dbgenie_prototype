// Express 5 types route params as string | string[] to accommodate repeated
// splat segments; a plain :name segment is always a single string. Used
// anywhere a route reads req.params.* — see middleware/require-role.ts for
// the original instance of this pattern.
export function reqParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : (value ?? "")
}
