type ClassValue = string | false | null | undefined;

export function classNames(...values: ClassValue[]) {
  return values.filter(Boolean).join(' ');
}
