// A photo's date as Immich's own date editor sends it: the local clock time with the photo's offset, e.g. 2023-11-05T02:00:00.000+05:30.
export function localDateWithOffset(dateTimeOriginal: string, localDateTime: string | null): string {
  const utc = Date.parse(dateTimeOriginal);
  const local = localDateTime === null ? Number.NaN : Date.parse(localDateTime);
  if (Number.isNaN(utc) || Number.isNaN(local)) return dateTimeOriginal;
  const minutes = Math.round((local - utc) / 60_000);
  if (Math.abs(minutes) > 18 * 60) return dateTimeOriginal;
  const sign = minutes < 0 ? "-" : "+";
  const hours = String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0");
  const rest = String(Math.abs(minutes) % 60).padStart(2, "0");
  return `${new Date(local).toISOString().slice(0, -1)}${sign}${hours}:${rest}`;
}
