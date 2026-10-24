/** Joins truthy class names: `cx("ui-button", small && "ui-button--sm")`. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}
