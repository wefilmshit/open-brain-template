export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function postgrestQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildTextSearchFilter(q: string): string {
  const pattern = postgrestQuote(`%${escapeLike(q)}%`);
  return `content.ilike.${pattern},summary.ilike.${pattern}`;
}
